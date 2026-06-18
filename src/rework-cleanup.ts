import type { Issue, Logger, TrackerConfig } from "./types.js";
import {
  fetchIssueCommentsDetail,
  deleteComment,
  updateIssueDescription,
  type LinearComment,
} from "./linear.js";
import { CLAUDE_HAIKU_MODEL } from "./llm.js";

/**
 * Marker that every Symphony agent comment on a Linear ticket starts with.
 * It's an HTML comment so it's invisible when Linear renders the body, but
 * easy to detect on the API side. Comments that start with this marker are
 * treated as AI-generated and deleted on rework cycles.
 */
export const AI_COMMENT_MARKER = "<!-- symphony-agent -->";

/**
 * Heading used inside the issue description to hold the human-comment summary
 * produced on a rework cycle. Replaced (not duplicated) on subsequent cycles.
 */
export const REWORK_NOTES_HEADING = "## Fix";

/** A comment is "AI" if its body starts with the marker (after trimming leading whitespace). */
export function isAiComment(comment: LinearComment): boolean {
  return comment.body.trimStart().startsWith(AI_COMMENT_MARKER);
}

/**
 * Replace an existing `## Rework notes` section in `description`, or append one.
 * The section runs until the next top-level heading (`## ` / `# ` at start of line)
 * or end of string, whichever comes first.
 */
export function upsertReworkNotes(description: string | null, body: string): string {
  const trimmedBody = body.trim();
  const section = `${REWORK_NOTES_HEADING}\n\n${trimmedBody}`;
  const existing = description ?? "";

  const headingPattern = new RegExp(
    `^${REWORK_NOTES_HEADING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
    "m",
  );
  const match = headingPattern.exec(existing);
  if (!match) {
    if (!existing.trim()) return section;
    return `${existing.trimEnd()}\n\n${section}`;
  }

  const start = match.index;
  const afterHeading = start + match[0].length;
  // Find the next top-level heading after this one.
  const nextHeading = /^#{1,2} /m.exec(existing.slice(afterHeading));
  const end = nextHeading ? afterHeading + nextHeading.index : existing.length;
  const before = existing.slice(0, start).trimEnd();
  const after = existing.slice(end).trimStart();

  const parts: string[] = [];
  if (before) parts.push(before);
  parts.push(section);
  if (after) parts.push(after);
  return parts.join("\n\n");
}

const SUMMARY_PROMPT = `Summarise reviewer comments on this Linear ticket.

Reviewer comments (in order):
---
{{comments}}
---

Use this exact format:

## Fix
- <one line per change needed>

Rules:
- One sentence per line. Verb first. No preamble.
- Omit "Done" section entirely.
- Skip chitchat / acknowledgements.
- Never write "reviewer said" — just state the action.`;

/** Calls Claude Haiku once to summarise the human reviewer comments. Returns null on any failure. */
async function summariseWithHaiku(commentBodies: string[]): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const joined = commentBodies
    .map((body, i) => `[${i + 1}] ${body.trim()}`)
    .join("\n\n");
  const userContent = SUMMARY_PROMPT.replace("{{comments}}", joined);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_HAIKU_MODEL,
        max_tokens: 800,
        messages: [{ role: "user", content: userContent }],
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) return null;
    const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
    const answer = (data.content?.[0]?.text ?? "").trim();
    return answer || null;
  } catch {
    return null;
  }
}

export interface ReworkCleanupResult {
  /** Number of AI-generated comments deleted. */
  deletedCount: number;
  /** True if the description was updated with a fresh rework summary. */
  descriptionUpdated: boolean;
}

/**
 * If the issue carries AI-generated comments (left over from prior agent runs),
 * delete them and replace any prior `## Rework notes` section in the description
 * with a fresh Done / To do summary of the reviewer's human comments.
 *
 * Skips entirely if no AI comments exist on the issue (= not a rework cycle).
 * Best-effort: any sub-step that throws is logged and the rest continues.
 */
export async function cleanupReworkComments(
  issue: Issue,
  config: TrackerConfig,
  logger: Logger,
): Promise<ReworkCleanupResult> {
  const empty: ReworkCleanupResult = { deletedCount: 0, descriptionUpdated: false };

  let comments: LinearComment[];
  try {
    comments = await fetchIssueCommentsDetail(config, issue.id);
  } catch (e) {
    logger.warn(`Rework cleanup: fetch comments failed: ${e instanceof Error ? e.message : String(e)}`, {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
    });
    return empty;
  }

  const aiComments = comments.filter(isAiComment);
  if (aiComments.length === 0) return empty;

  logger.info("Rework cycle detected, cleaning up AI comments", {
    issue_id: issue.id,
    issue_identifier: issue.identifier,
    ai_comment_count: aiComments.length,
  });

  // Summarise the human comments that arrived after the most recent AI delivery
  // comment — those are the rework notes from the reviewer. If none, skip the
  // description update but still delete the AI comments.
  const lastAiAt = aiComments
    .map(c => c.createdAt.getTime())
    .reduce((max, t) => Math.max(max, t), 0);
  const humanReworkComments = comments.filter(
    c => !isAiComment(c) && c.createdAt.getTime() > lastAiAt && c.body.trim().length > 0,
  );

  let descriptionUpdated = false;
  if (humanReworkComments.length > 0) {
    const summary = await summariseWithHaiku(humanReworkComments.map(c => c.body));
    if (summary) {
      try {
        const nextDescription = upsertReworkNotes(issue.description, summary);
        await updateIssueDescription(config, issue.id, nextDescription);
        descriptionUpdated = true;
        // Mutate the issue object in place so the dispatched agent reads the
        // updated description in the same tick.
        issue.description = nextDescription;
      } catch (e) {
        logger.warn(`Rework cleanup: description update failed: ${e instanceof Error ? e.message : String(e)}`, {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
        });
      }
    } else {
      logger.warn("Rework cleanup: Haiku summary unavailable, skipping description update", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      });
    }
  }

  let deletedCount = 0;
  for (const comment of aiComments) {
    try {
      await deleteComment(config, comment.id);
      deletedCount += 1;
    } catch (e) {
      logger.warn(`Rework cleanup: delete comment failed: ${e instanceof Error ? e.message : String(e)}`, {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        comment_id: comment.id,
      });
    }
  }

  logger.info("Rework cleanup complete", {
    issue_id: issue.id,
    issue_identifier: issue.identifier,
    deleted_count: deletedCount,
    description_updated: descriptionUpdated,
  });

  return { deletedCount, descriptionUpdated };
}
