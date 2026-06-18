import * as fs from "node:fs";
import type { Issue } from "./types.js";

/**
 * One retrospective record from `lessons.jsonl`. The schema is owned by
 * `prompts/RETROSPECTIVE.md`; this interface lists only the fields the
 * dispatch-time retriever reads. Unknown fields are tolerated.
 */
export interface Lesson {
  ticket?: string;
  ticket_url?: string;
  completed_at?: string;
  outcome?: string;
  primary_miss?: string;
  miss_root_cause?: string;
  what_would_have_caught_it_earlier?: string;
  proposed_workflow_change?: string;
  tags?: string[];
  notes?: string;
  [key: string]: unknown;
}

export interface ScoredLesson {
  lesson: Lesson;
  score: number;
}

// Tokens shorter than this carry little signal and inflate spurious overlaps.
const MIN_TOKEN_LENGTH = 4;

// Common words that overlap between unrelated tickets without indicating
// relevance. Kept deliberately small — the goal is to drop noise, not to build
// a linguistics-grade stoplist.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "into", "when", "then",
  "than", "have", "has", "had", "was", "were", "will", "would", "should",
  "could", "been", "being", "are", "but", "not", "use", "used", "using",
  "add", "added", "adds", "fix", "fixed", "fixes", "update", "updated",
  "updates", "change", "changed", "changes", "make", "made", "all", "any",
  "new", "via", "per", "out", "off", "set", "get", "got", "ticket", "issue",
  "page", "code", "test", "tests", "none", "team", "dsc", "https", "http",
  "linear", "app", "com",
]);

/**
 * Lowercase, split on non-alphanumeric boundaries, drop short tokens and
 * stopwords. Returns a Set so callers can intersect cheaply.
 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  if (!text) return tokens;
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

/**
 * Read and parse `lessons.jsonl`. Malformed lines are skipped silently — the
 * retrospective should never emit them, but one bad line must not sink the
 * whole retrieval. Returns [] when the file is missing or unreadable.
 */
export function readLessons(lessonsPath: string): Lesson[] {
  let content: string;
  try {
    content = fs.readFileSync(lessonsPath, "utf-8");
  } catch {
    return [];
  }
  const lessons: Lesson[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Lesson;
      if (obj && typeof obj === "object") lessons.push(obj);
    } catch {
      continue;
    }
  }
  return lessons;
}

/**
 * A lesson is instructive only if it carries a warning a future ticket could
 * act on: a real miss, or a concrete proposed change. A spotless ship with no
 * proposed change teaches nothing and would only dilute the injected context.
 */
export function isInstructive(lesson: Lesson): boolean {
  const miss = (lesson.primary_miss ?? "").trim().toLowerCase();
  if (miss && miss !== "none") return true;
  if ((lesson.proposed_workflow_change ?? "").trim()) return true;
  return false;
}

/** Combine the lesson's textual fields into one searchable blob. */
function lessonText(lesson: Lesson): string {
  const parts = [
    lesson.ticket_url ?? "",
    lesson.primary_miss ?? "",
    lesson.miss_root_cause ?? "",
    lesson.what_would_have_caught_it_earlier ?? "",
    lesson.proposed_workflow_change ?? "",
    lesson.notes ?? "",
    (lesson.tags ?? []).join(" "),
  ];
  return parts.join(" ");
}

/**
 * Rank instructive lessons by keyword overlap with the issue. No vector store:
 * the corpus is a few hundred lines, so deterministic token overlap is both
 * sufficient and explainable. The agent makes the final relevance call — this
 * just surfaces candidates worth its attention.
 */
export function selectRelevantLessons(
  lessons: Lesson[],
  issue: Issue,
  max = 5,
): ScoredLesson[] {
  const issueTokens = tokenize(
    [issue.title ?? "", issue.description ?? "", (issue.labels ?? []).join(" ")].join(" "),
  );
  if (issueTokens.size === 0) return [];

  const scored: ScoredLesson[] = [];
  for (const lesson of lessons) {
    if (!isInstructive(lesson)) continue;
    const lessonTokens = tokenize(lessonText(lesson));
    let score = 0;
    for (const tok of lessonTokens) {
      if (issueTokens.has(tok)) score++;
    }
    if (score > 0) scored.push({ lesson, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tie-break on recency: a newer lesson reflects the current codebase better.
    const at = Date.parse(a.lesson.completed_at ?? "") || 0;
    const bt = Date.parse(b.lesson.completed_at ?? "") || 0;
    return bt - at;
  });

  return scored.slice(0, max);
}

function truncate(text: string, len: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= len ? t : t.slice(0, len - 1).trimEnd() + "…";
}

/**
 * Render ranked lessons as a compact markdown block for prompt injection.
 * Returns "" when there is nothing worth injecting, so the WORKFLOW template
 * can gate the whole section on a non-empty string.
 */
export function renderRelevantLessons(scored: ScoredLesson[]): string {
  if (scored.length === 0) return "";
  const lines: string[] = [];
  for (const { lesson } of scored) {
    const id = lesson.ticket ?? "(unknown ticket)";
    const outcome = lesson.outcome ? ` (${lesson.outcome})` : "";
    const miss = (lesson.primary_miss ?? "").trim();
    const cause = (lesson.miss_root_cause ?? "").trim();
    const change = (lesson.proposed_workflow_change ?? "").trim();

    let line = `- **${id}**${outcome}`;
    if (miss && miss.toLowerCase() !== "none") line += ` — ${truncate(miss, 80)}`;
    if (cause) line += `: ${truncate(cause, 200)}`;
    if (change) line += ` → ${truncate(change, 200)}`;
    lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Convenience: read, rank, and render in one call. Used by the dispatcher to
 * produce the `relevant_lessons` prompt variable. Never throws — any failure
 * yields an empty string so a retrieval hiccup can't block a ticket.
 */
export function relevantLessonsForIssue(lessonsPath: string, issue: Issue, max = 5): string {
  try {
    const lessons = readLessons(lessonsPath);
    if (lessons.length === 0) return "";
    return renderRelevantLessons(selectRelevantLessons(lessons, issue, max));
  } catch {
    return "";
  }
}
