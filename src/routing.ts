/**
 * Pre-build routing (ORCHESTRATOR_REDESIGN §6, point 1): from ticket labels and
 * text, decide whether a PLAN stage is needed, whether it's a UI change, and
 * which REVIEW lenses apply. Deterministic and logged — no model call.
 */
import { extractDesignLinks } from "./design-links.js";

export interface Route {
  plan: boolean;
  ui: boolean;
  lenses: string[];
  reasons: string[];
}

export type Lens = "PERFORMANCE" | "ACCESSIBILITY" | "MOBILE_UX" | "CLEAR_WRITING";
const LENS_ORDER: Lens[] = ["PERFORMANCE", "ACCESSIBILITY", "MOBILE_UX", "CLEAR_WRITING"];

/** Labels compared after lower-casing and dropping spaces, hyphens and underscores. */
function normLabel(label: string): string {
  return label.toLowerCase().replace(/[\s_-]+/g, "");
}

/** Labels that always want a PLAN stage. */
const PLAN_LABELS = new Set(["feature", "improvement", "designneeded", "techdebt"]);
/** Watcher-created tickets: well-specified by construction, so no PLAN when the description is clear. */
const AUTOMATED_LABELS = new Set(["dependabot", "firebaselogs", "posthog"]);
const BUG_LABEL = "bug";

const THIN_DESCRIPTION_CHARS = 120;

const PLAN_KEYWORDS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bmigrat(?:e|es|ed|ing|ion|ions)\b/i, reason: "mentions a migration" },
  { re: /\bschemas?\b/i, reason: "mentions a schema change" },
  { re: /\barchitect(?:ure|ural)?\b/i, reason: "mentions architecture" },
  { re: /\brefactor(?:s|ed|ing)?\b/i, reason: "mentions a refactor" },
  {
    re: /\bnew\s+(?:firestore\s+|data\s+|db\s+|database\s+)?(?:collections?|tables?|models?)\b/i,
    reason: "adds a new collection/table/model",
  },
];

const UI_WORDS = /\b(?:ui|pages?|buttons?|layouts?|mobile|screens?|styles?|styling|css|modals?|dialogs?|responsive)\b/i;
const PERF_WORDS = /\b(?:slow|slowness|slower|perf|performance|latency|load\s+time)\b/i;
const WRITING_WORDS = /\b(?:copy|text|wording|emails?|typos?|spelling)\b/i;

/** Numbered or bulleted list lines, or an explicit "steps" heading. */
function hasSteps(text: string): boolean {
  return /^\s*(?:\d+[.)]|[-*•])\s+\S/m.test(text) || /\bsteps?\s+to\s+reproduce\b/i.test(text);
}

export function routeTicket(issue: {
  title: string;
  description: string | null;
  labels: string[];
  priority: number | null;
}): Route {
  const labels = new Set(issue.labels.map(normLabel));
  const description = (issue.description ?? "").trim();
  const text = `${issue.title}\n${description}`;
  const reasons: string[] = [];

  const thin = description.length < THIN_DESCRIPTION_CHARS && !hasSteps(description);
  const designLinks = extractDesignLinks(text);
  const automated = [...labels].find(l => AUTOMATED_LABELS.has(l));
  const planLabel = issue.labels.find(l => PLAN_LABELS.has(normLabel(l)));

  // ---- plan ----
  let plan = false;
  if (planLabel) {
    plan = true;
    reasons.push(`plan: label "${planLabel}"`);
  } else if (automated && !thin) {
    plan = false;
    reasons.push(`no plan: ${automated} ticket with a clear description`);
  } else {
    const planWhy: string[] = [];
    if (designLinks.length > 0) planWhy.push("has a design link");
    for (const k of PLAN_KEYWORDS) if (k.re.test(text)) planWhy.push(k.reason);
    // A Bug label only vouches for the ticket when the description is clear;
    // thin tickets of any kind get a PLAN to pin down intent first.
    if (thin) planWhy.push(`thin description (<${THIN_DESCRIPTION_CHARS} chars, no steps)`);
    if (planWhy.length > 0) {
      plan = true;
      reasons.push(`plan: ${planWhy.join("; ")}`);
    } else if (labels.has(BUG_LABEL)) {
      reasons.push("no plan: bug with a clear description");
    } else {
      reasons.push("no plan: clear, small-scope ticket");
    }
  }

  // ---- ui ----
  const uiWhy: string[] = [];
  if (labels.has("designneeded")) uiWhy.push('label "Design needed"');
  if (labels.has("uxinsights")) uiWhy.push('label "ux-insights"');
  if (designLinks.length > 0) uiWhy.push("design link");
  const uiWord = UI_WORDS.exec(text);
  if (uiWord) uiWhy.push(`mentions "${uiWord[0].toLowerCase()}"`);
  const ui = uiWhy.length > 0;
  if (ui) reasons.push(`ui: ${uiWhy.join("; ")}`);

  // ---- lenses ----
  const lenses = new Set<Lens>();
  if (ui) {
    lenses.add("ACCESSIBILITY");
    lenses.add("MOBILE_UX");
  }
  if (labels.has("queryinsights") || PERF_WORDS.test(text)) {
    lenses.add("PERFORMANCE");
    reasons.push(labels.has("queryinsights") ? 'lens PERFORMANCE: label "query-insights"' : "lens PERFORMANCE: mentions slowness/performance");
  }
  const writing = WRITING_WORDS.exec(text);
  if (writing) {
    lenses.add("CLEAR_WRITING");
    reasons.push(`lens CLEAR_WRITING: mentions "${writing[0].toLowerCase()}"`);
  }

  return { plan, ui, lenses: LENS_ORDER.filter(l => lenses.has(l)), reasons };
}
