import type { Issue, IssuePerson, Logger, SlackNotificationsConfig } from "./types.js";

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

export function buildStakeholderContext(issue: Issue): string {
  const descriptionSentence = firstSentence(issue.description);
  if (descriptionSentence && descriptionSentence.toLowerCase() !== issue.title.toLowerCase()) {
    return descriptionSentence;
  }

  if (issue.labels.length > 0) {
    return `Relevant area: ${issue.labels.slice(0, 3).join(", ")}.`;
  }

  return `${issue.identifier} is complete and ready for stakeholder follow-through.`;
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

export function buildSlackCompletionPayload(
  issue: Issue,
  completionState: string,
  completionSummary: string | null,
  slack: SlackNotificationsConfig,
): { text: string; blocks: Array<Record<string, unknown>> } {
  const delivered = buildDeliverySummary(issue, completionSummary);
  const context = buildStakeholderContext(issue);
  const mentions = collectMentions(issue, slack.userMap);
  const mentionText = mentions.length > 0 ? mentions.join(" ") : "No mapped collaborators";
  const linkText = issue.url ? `<${issue.url}|Open ticket>` : issue.identifier;

  return {
    text: `${issue.identifier} completed: ${delivered}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${issue.identifier} marked ${completionState}`,
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Delivered*\n${delivered}`,
          },
          {
            type: "mrkdwn",
            text: `*Context*\n${context}`,
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*People*\n${mentionText}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Linear*\n${linkText}`,
        },
      },
    ],
  };
}

export async function sendSlackCompletionNotification(
  issue: Issue,
  completionState: string,
  completionSummary: string | null,
  slack: SlackNotificationsConfig,
  logger: Logger,
): Promise<void> {
  const payload = buildSlackCompletionPayload(issue, completionState, completionSummary, slack);

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

  logger.info("Slack completion notification sent", {
    issue_id: issue.id,
    issue_identifier: issue.identifier,
    state: completionState,
  });
}
