import type { Issue, IssuePerson, Logger, PendingSlackNotification, SlackNotificationsConfig } from "./types.js";

function cleanText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/[*_>#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractListItems(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(line => line && !/^(tests?|verification|next steps?|blockers?|risks?)\b/i.test(line));
}

function firstSentence(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = cleanText(value);
  if (!cleaned) return null;
  const match = cleaned.match(/.+?[.!?](?=\s|$)/);
  return (match?.[0] ?? cleaned).trim().slice(0, 280);
}

function fallbackSummary(issue: Issue): string {
  const descriptionSentence = firstSentence(issue.description);
  if (descriptionSentence && descriptionSentence.toLowerCase() !== issue.title.toLowerCase()) {
    return descriptionSentence;
  }
  return issue.title.trim();
}

export function buildDeliverySummary(issue: Issue, completionSummary: string | null): string {
  if (completionSummary) {
    const bullets = extractListItems(completionSummary)
      .map(item => cleanText(item))
      .filter(Boolean)
      .filter(item => item.length >= 20)
      .slice(0, 2);
    if (bullets.length > 0) {
      return bullets.join("; ").slice(0, 280);
    }

    const summarySentence = firstSentence(completionSummary);
    if (summarySentence) return summarySentence;
  }

  return fallbackSummary(issue);
}

function normalizeMentionValue(value: string): string {
  return value.startsWith("<") ? value : `<@${value}>`;
}

function lookupMention(person: IssuePerson, userMap: Record<string, string>): string | null {
  const candidates = [person.name, person.name.toLowerCase()];
  if (person.email) {
    candidates.push(person.email, person.email.toLowerCase());
  }

  for (const candidate of candidates) {
    const mapped = userMap[candidate];
    if (mapped) return normalizeMentionValue(mapped);
  }

  return null;
}

export function collectMentions(issue: Issue, userMap: Record<string, string>): string[] {
  const seen = new Set<string>();
  const mentions: string[] = [];

  for (const person of [issue.assignee, issue.creator]) {
    if (!person) continue;
    const mention = lookupMention(person, userMap);
    if (!mention || seen.has(mention)) continue;
    seen.add(mention);
    mentions.push(mention);
  }

  return mentions;
}

export function isCompletionState(state: string): boolean {
  return !/(cancelled|canceled|duplicate)/i.test(state);
}

export function buildBatchedSlackPayload(
  items: PendingSlackNotification[],
  slack: SlackNotificationsConfig,
): { text: string; blocks: Array<Record<string, unknown>> } {
  const itemsText = items
    .map(({ issue, completionSummary }) => {
      const target = issue.url ?? issue.identifier;
      const summary = buildDeliverySummary(issue, completionSummary);
      return `- ${target}\n${summary}`;
    })
    .join("\n\n");

  const allMentions = new Set<string>();
  for (const { issue } of items) {
    for (const mention of collectMentions(issue, slack.userMap)) {
      allMentions.add(mention);
    }
  }

  const parts = ["DONE:", itemsText];
  if (allMentions.size > 0) {
    parts.push("", [...allMentions].join(", "));
  }
  const message = parts.join("\n");

  return {
    text: message,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: message,
        },
      },
    ],
  };
}

export async function sendBatchedSlackNotification(
  items: PendingSlackNotification[],
  slack: SlackNotificationsConfig,
  logger: Logger,
): Promise<void> {
  const payload = buildBatchedSlackPayload(items, slack);

  logger.info("Sending batched Slack notification", {
    count: items.length,
    identifiers: items.map(i => i.issue.identifier).join(", "),
    preview: payload.text.slice(0, 200),
  });

  let response: Response;
  try {
    response = await fetch(slack.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(`Slack webhook request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Slack webhook returned HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  logger.info("Batched Slack completion notification sent", { count: items.length });
}
