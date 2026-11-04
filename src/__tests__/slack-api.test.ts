import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SlackApiError,
  fetchHistory,
  getPermalink,
  openDm,
  postMessage,
  slackCall,
  updateMessage,
} from "../slack-api.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockFetch(...responses: unknown[]) {
  const fn = vi.fn<typeof fetch>();
  for (const r of responses) fn.mockResolvedValueOnce(jsonResponse(r));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("slackCall", () => {
  it("POSTs JSON with bearer auth and a timeout signal", async () => {
    const fetchFn = mockFetch({ ok: true, foo: 1 });
    const res = await slackCall<{ foo: number }>("xoxb-1", "chat.postMessage", { channel: "C1", text: "hi" });
    expect(res.foo).toBe(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-1");
    expect(JSON.parse(init?.body as string)).toEqual({ channel: "C1", text: "hi" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws SlackApiError with the error code on ok:false", async () => {
    mockFetch({ ok: false, error: "channel_not_found" });
    const err = await slackCall("xoxb-1", "chat.postMessage", {}).catch((e) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect(err.code).toBe("channel_not_found");
    expect(err.message).toContain("channel_not_found");
  });

  it("throws on HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("nope", { status: 500 })));
    await expect(slackCall("t", "x", {})).rejects.toMatchObject({ code: "http_500" });
  });

  it("can send form-encoded bodies", async () => {
    const fetchFn = mockFetch({ ok: true });
    await slackCall("t", "conversations.history", { channel: "C1", limit: 5 }, { encoding: "form" });
    const init = fetchFn.mock.calls[0][1];
    expect((init?.headers as Record<string, string>)["Content-Type"]).toContain("x-www-form-urlencoded");
    expect(init?.body).toBe("channel=C1&limit=5");
  });
});

describe("helpers", () => {
  it("openDm returns the channel id", async () => {
    const fetchFn = mockFetch({ ok: true, channel: { id: "D123" } });
    await expect(openDm("t", "U1")).resolves.toBe("D123");
    expect(JSON.parse(fetchFn.mock.calls[0][1]?.body as string)).toEqual({ users: "U1" });
  });

  it("postMessage returns channel + ts and passes blocks", async () => {
    const fetchFn = mockFetch({ ok: true, channel: "C1", ts: "1.2" });
    const blocks = [{ type: "divider" }];
    await expect(postMessage("t", "C1", "hi", blocks)).resolves.toEqual({ channel: "C1", ts: "1.2" });
    expect(JSON.parse(fetchFn.mock.calls[0][1]?.body as string).blocks).toEqual(blocks);
  });

  it("updateMessage calls chat.update", async () => {
    const fetchFn = mockFetch({ ok: true });
    await updateMessage("t", "C1", "1.2", "new");
    expect(fetchFn.mock.calls[0][0]).toBe("https://slack.com/api/chat.update");
  });

  it("fetchHistory follows cursors and maps fields", async () => {
    const fetchFn = mockFetch(
      {
        ok: true,
        messages: [{ ts: "3", user: "U1", text: "a", thread_ts: "1" }],
        response_metadata: { next_cursor: "abc" },
      },
      { ok: true, messages: [{ ts: "2", bot_id: "B1", subtype: "bot_message", text: "b" }], response_metadata: { next_cursor: "" } },
    );
    const msgs = await fetchHistory("t", "C1", "1.0", 50);
    expect(msgs).toEqual([
      { ts: "3", user: "U1", text: "a", threadTs: "1" },
      { ts: "2", botId: "B1", subtype: "bot_message", text: "b" },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1][1]?.body).toContain("cursor=abc");
    expect(fetchFn.mock.calls[0][1]?.body).toContain("oldest=1.0");
  });

  it("getPermalink returns null on failure", async () => {
    mockFetch({ ok: true, permalink: "https://x.slack.com/p1" }, { ok: false, error: "message_not_found" });
    await expect(getPermalink("t", "C1", "1")).resolves.toBe("https://x.slack.com/p1");
    await expect(getPermalink("t", "C1", "2")).resolves.toBeNull();
  });
});
