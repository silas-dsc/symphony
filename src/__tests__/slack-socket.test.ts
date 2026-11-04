import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackSocket, type SlackAction, type WebSocketLike } from "../slack-socket.js";
import type { Logger } from "../types.js";

class FakeWs implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({});
  }
  receive(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  /** Simulates the server dropping the connection. */
  drop() {
    this.closed = true;
    this.onclose?.({});
  }
}

const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

let sockets: FakeWs[];
let fetchFn: ReturnType<typeof vi.fn<typeof fetch>>;

function makeSocket(onAction: (a: SlackAction) => Promise<void> = async () => {}) {
  return new SlackSocket("xapp-1", log, onAction, (url) => {
    const ws = new FakeWs(url);
    sockets.push(ws);
    return ws;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  let n = 0;
  fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => {
    n++;
    return new Response(JSON.stringify({ ok: true, url: `wss://example/${n}` }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchFn);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const blockActions = {
  envelope_id: "env-2",
  type: "interactive",
  payload: {
    type: "block_actions",
    user: { id: "U1", username: "silas" },
    channel: { id: "C1" },
    container: { message_ts: "111.222", channel_id: "C1" },
    response_url: "https://hooks.slack.com/r/1",
    actions: [
      { action_id: "symphony_gate:approve", value: "g1:approve" },
      { action_id: "symphony_gate:forward", value: "g1:forward" },
    ],
  },
};

describe("SlackSocket", () => {
  it("opens a connection with the app token", async () => {
    const s = makeSocket();
    await s.start();
    expect(fetchFn.mock.calls[0][0]).toBe("https://slack.com/api/apps.connections.open");
    expect((fetchFn.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe("Bearer xapp-1");
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe("wss://example/1");
    s.stop();
  });

  it("acks every envelope", async () => {
    const s = makeSocket();
    await s.start();
    sockets[0].receive({ envelope_id: "env-1", type: "events_api", payload: {} });
    expect(sockets[0].sent).toEqual([JSON.stringify({ envelope_id: "env-1" })]);
    s.stop();
  });

  it("dispatches block_actions once per action", async () => {
    const seen: SlackAction[] = [];
    const s = makeSocket(async (a) => {
      seen.push(a);
    });
    await s.start();
    sockets[0].receive(blockActions);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0].sent).toContain(JSON.stringify({ envelope_id: "env-2" }));
    expect(seen).toEqual([
      {
        actionId: "symphony_gate:approve",
        value: "g1:approve",
        userId: "U1",
        userName: "silas",
        channel: "C1",
        messageTs: "111.222",
        responseUrl: "https://hooks.slack.com/r/1",
      },
      expect.objectContaining({ actionId: "symphony_gate:forward", value: "g1:forward" }),
    ]);
    s.stop();
  });

  it("logs and swallows handler errors", async () => {
    const calls: string[] = [];
    const s = makeSocket(async (a) => {
      calls.push(a.actionId);
      throw new Error("boom");
    });
    await s.start();
    sockets[0].receive(blockActions);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    expect(log.error).toHaveBeenCalled();
    s.stop();
  });

  it("reconnects with doubling backoff after close", async () => {
    const s = makeSocket();
    await s.start();
    sockets[0].drop();
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].url).toBe("wss://example/2");

    sockets[1].drop();
    await vi.advanceTimersByTimeAsync(1999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);

    // hello resets the backoff
    sockets[2].receive({ type: "hello" });
    sockets[2].drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(4);
    s.stop();
  });

  it("reconnects once on a disconnect envelope", async () => {
    const s = makeSocket();
    await s.start();
    sockets[0].receive({ type: "disconnect", reason: "refresh_requested" });
    expect(sockets[0].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(2);
    s.stop();
  });

  it("does not reconnect after stop", async () => {
    const s = makeSocket();
    await s.start();
    s.stop();
    expect(sockets[0].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("stop cancels a pending reconnect", async () => {
    const s = makeSocket();
    await s.start();
    sockets[0].drop();
    s.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);
  });

  it("does not retry when the app token is rejected", async () => {
    fetchFn.mockImplementation(async () => new Response(JSON.stringify({ ok: false, error: "invalid_auth" })));
    const s = makeSocket();
    await s.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(0);
  });
});
