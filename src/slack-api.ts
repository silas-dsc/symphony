/**
 * Thin Slack Web API helpers (no SDK, no new deps). Every call goes through
 * `slackCall`, which POSTs to https://slack.com/api/<method>, applies a 15s
 * timeout and throws `SlackApiError` when Slack answers `ok:false`.
 */

const SLACK_API_BASE = "https://slack.com/api";
const SLACK_TIMEOUT_MS = 15_000;

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`Slack ${method} failed: ${code}`);
    this.name = "SlackApiError";
  }
}

export interface SlackCallOptions {
  /**
   * "json" (default) sends an application/json body. "form" sends
   * application/x-www-form-urlencoded — some read methods (e.g.
   * conversations.history, chat.getPermalink) ignore JSON bodies.
   */
  encoding?: "json" | "form";
}

export interface SlackMessage {
  ts: string;
  user?: string;
  text: string;
  threadTs?: string;
  botId?: string;
  subtype?: string;
}

function toForm(body: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return params.toString();
}

export async function slackCall<T = Record<string, unknown>>(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
  opts: SlackCallOptions = {},
): Promise<T> {
  const form = opts.encoding === "form";
  const response = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8",
    },
    body: form ? toForm(body) : JSON.stringify(body),
    signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new SlackApiError(method, `http_${response.status}`);
  }

  const data = (await response.json().catch(() => null)) as ({ ok?: boolean; error?: string } & T) | null;
  if (!data || data.ok !== true) {
    throw new SlackApiError(method, data?.error ?? "invalid_response");
  }
  return data;
}

export async function openDm(botToken: string, userId: string): Promise<string> {
  const res = await slackCall<{ channel?: { id?: string } }>(botToken, "conversations.open", { users: userId });
  const id = res.channel?.id;
  if (!id) throw new SlackApiError("conversations.open", "missing_channel");
  return id;
}

export async function postMessage(
  botToken: string,
  channel: string,
  text: string,
  blocks?: unknown[],
): Promise<{ channel: string; ts: string }> {
  const res = await slackCall<{ channel: string; ts: string }>(botToken, "chat.postMessage", {
    channel,
    text,
    ...(blocks ? { blocks } : {}),
    unfurl_links: false,
    unfurl_media: false,
  });
  return { channel: res.channel, ts: res.ts };
}

export async function updateMessage(
  botToken: string,
  channel: string,
  ts: string,
  text: string,
  blocks?: unknown[],
): Promise<void> {
  await slackCall(botToken, "chat.update", { channel, ts, text, ...(blocks ? { blocks } : {}) });
}

export async function postEphemeral(botToken: string, channel: string, user: string, text: string): Promise<void> {
  await slackCall(botToken, "chat.postEphemeral", { channel, user, text });
}

interface RawHistoryMessage {
  ts: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
}

interface HistoryResponse {
  messages?: RawHistoryMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

/** Messages in `channel` newer than `oldestTs`, following cursors until exhausted. Newest first, as Slack returns them. */
export async function fetchHistory(
  botToken: string,
  channel: string,
  oldestTs: string,
  limit = 200,
): Promise<SlackMessage[]> {
  const out: SlackMessage[] = [];
  let cursor: string | undefined;
  // Hard stop so a misbehaving cursor can never loop forever.
  for (let page = 0; page < 50; page++) {
    const res = await slackCall<HistoryResponse>(
      botToken,
      "conversations.history",
      { channel, oldest: oldestTs, limit, ...(cursor ? { cursor } : {}) },
      { encoding: "form" },
    );
    for (const m of res.messages ?? []) {
      out.push({
        ts: m.ts,
        text: m.text ?? "",
        ...(m.user ? { user: m.user } : {}),
        ...(m.thread_ts ? { threadTs: m.thread_ts } : {}),
        ...(m.bot_id ? { botId: m.bot_id } : {}),
        ...(m.subtype ? { subtype: m.subtype } : {}),
      });
    }
    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return out;
}

/** Permalink for a message, or null when Slack can't produce one. */
export async function getPermalink(botToken: string, channel: string, ts: string): Promise<string | null> {
  try {
    const res = await slackCall<{ permalink?: string }>(
      botToken,
      "chat.getPermalink",
      { channel, message_ts: ts },
      { encoding: "form" },
    );
    return res.permalink ?? null;
  } catch {
    return null;
  }
}
