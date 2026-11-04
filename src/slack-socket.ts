/**
 * Slack Socket Mode client. Symphony runs on a laptop with no public URL, so
 * button clicks arrive over an outbound WebSocket instead of an HTTP endpoint.
 *
 * Flow: apps.connections.open (app-level xapp- token) → wss URL → connect.
 * Every envelope is acked immediately with `{envelope_id}`; `block_actions`
 * interactions are dispatched to `onAction`, one call per action.
 * Uses Node's global WebSocket (Node 22+) — no extra dependency.
 */

import { slackCall, SlackApiError } from "./slack-api.js";
import type { Logger } from "./types.js";

export interface SlackAction {
  actionId: string;
  value: string;
  userId: string;
  userName: string;
  channel: string | null;
  messageTs: string | null;
  responseUrl: string | null;
}

/** The subset of the WebSocket API SlackSocket uses (lets tests inject a fake). */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
/** Errors from apps.connections.open that retrying can't fix. */
const FATAL_OPEN_ERRORS = new Set(["invalid_auth", "not_authed", "not_allowed_token_type", "account_inactive", "token_revoked"]);

interface Envelope {
  envelope_id?: string;
  type?: string;
  reason?: string;
  payload?: BlockActionsPayload;
}

interface BlockActionsPayload {
  type?: string;
  user?: { id?: string; username?: string; name?: string };
  channel?: { id?: string };
  container?: { channel_id?: string; message_ts?: string };
  message?: { ts?: string };
  response_url?: string;
  actions?: Array<{ action_id?: string; value?: string }>;
}

const defaultFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;

function dataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return String(data);
}

export class SlackSocket {
  private ws: WebSocketLike | null = null;
  private stopped = true;
  private backoffMs = MIN_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly wsFactory: WebSocketFactory;

  constructor(
    private readonly appToken: string,
    private readonly log: Logger,
    private readonly onAction: (a: SlackAction) => Promise<void>,
    wsFactory?: WebSocketFactory,
  ) {
    this.wsFactory = wsFactory ?? defaultFactory;
  }

  /** Opens the connection. Failures are logged and retried with backoff (except bad tokens). */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let url: string;
    try {
      const res = await slackCall<{ url?: string }>(this.appToken, "apps.connections.open", {});
      if (!res.url) throw new SlackApiError("apps.connections.open", "missing_url");
      url = res.url;
    } catch (err) {
      if (err instanceof SlackApiError && FATAL_OPEN_ERRORS.has(err.code)) {
        this.log.error("Slack socket: app token rejected; not retrying", { error: err.code });
        this.stopped = true;
        return;
      }
      this.log.warn("Slack socket: apps.connections.open failed", { error: String(err) });
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;

    let ws: WebSocketLike;
    try {
      ws = this.wsFactory(url);
    } catch (err) {
      this.log.warn("Slack socket: could not create WebSocket", { error: String(err) });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws === ws) this.log.info("Slack socket: connected");
    };
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.handleMessage(ws, dataToString(ev.data));
    };
    ws.onerror = (ev) => {
      if (this.ws === ws) this.log.warn("Slack socket: error", { error: String((ev as { message?: string })?.message ?? ev) });
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // superseded or stopped
      this.ws = null;
      this.log.warn("Slack socket: closed");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.log.info("Slack socket: reconnecting", { delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private handleMessage(ws: WebSocketLike, raw: string): void {
    let env: Envelope;
    try {
      env = JSON.parse(raw) as Envelope;
    } catch {
      this.log.warn("Slack socket: unparseable frame", { raw: raw.slice(0, 200) });
      return;
    }

    if (env.envelope_id) {
      try {
        ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
      } catch (err) {
        this.log.warn("Slack socket: ack failed", { error: String(err) });
      }
    }

    switch (env.type) {
      case "hello":
        this.backoffMs = MIN_BACKOFF_MS;
        return;
      case "disconnect": {
        this.log.info("Slack socket: server asked to disconnect", { reason: env.reason ?? null });
        this.ws = null;
        try {
          ws.close();
        } catch {
          // ignore
        }
        this.scheduleReconnect();
        return;
      }
      case "interactive":
        if (env.payload?.type === "block_actions") void this.dispatch(env.payload);
        return;
      default:
        return;
    }
  }

  private async dispatch(payload: BlockActionsPayload): Promise<void> {
    const base = {
      userId: payload.user?.id ?? "",
      userName: payload.user?.username ?? payload.user?.name ?? "",
      channel: payload.channel?.id ?? payload.container?.channel_id ?? null,
      messageTs: payload.container?.message_ts ?? payload.message?.ts ?? null,
      responseUrl: payload.response_url ?? null,
    };
    for (const a of payload.actions ?? []) {
      if (!a.action_id) continue;
      try {
        await this.onAction({ ...base, actionId: a.action_id, value: a.value ?? "" });
      } catch (err) {
        this.log.error("Slack socket: action handler failed", { actionId: a.action_id, error: String(err) });
      }
    }
  }
}
