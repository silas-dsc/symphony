/**
 * Spot design references in a ticket so the agent saves a pinned copy of the
 * design (`design/<TEA-id>.html` in the app repo) before building. Claude
 * Design artifacts are the main source; Figma links are still recognised.
 *
 * Deterministic on purpose — no model call to decide whether a ticket has a
 * design. Order of first appearance is kept; duplicates are dropped.
 */

const DESIGN_URL_PATTERNS: RegExp[] = [
  // Claude Design / artifacts: claude.ai/design/…, claude.ai/artifact/…,
  // claude.ai/code/artifact/…, claude.ai/public/artifacts/…, published claude.site pages.
  /^https:\/\/(?:www\.)?claude\.ai\/(?:design|artifact|artifacts|code\/artifact|public\/artifacts)\/[^\s]+$/i,
  /^https:\/\/[a-z0-9-]+\.claude\.site\/[^\s]*$/i,
  /^https:\/\/(?:www\.)?claude\.site\/[^\s]+$/i,
  // Figma files, prototypes and Make files.
  /^https:\/\/(?:www\.)?figma\.com\/(?:design|file|proto|make)\/[^\s]+$/i,
];

const URL_RE = /https:\/\/[^\s<>()\[\]"'`]+/gi;

/** Trailing punctuation that is almost always prose, not part of the URL. */
function trimUrl(url: string): string {
  return url.replace(/[.,;:!?*_]+$/, "");
}

export function extractDesignLinks(text: string | null | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const url = trimUrl(match[0]);
    if (seen.has(url)) continue;
    if (DESIGN_URL_PATTERNS.some(p => p.test(url))) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/** Repo-relative path the pinned design copy is saved to. */
export function designExportPath(issueIdentifier: string): string {
  return `design/${issueIdentifier}.html`;
}
