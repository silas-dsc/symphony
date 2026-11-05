import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { executeGraphQL } from "./linear.js";
import { waitingOn } from "./governor.js";
import type { TrackerConfig } from "./types.js";

/**
 * Product roadmap ("Feature roadmap: What's next?"): the team's priority list,
 * kept as a ranked list of Linear tickets, edited at teamdsc.com.au/dashboard/roadmap.
 * Symphony reads it from the site's feed (`url`, bearer `token`), caching each
 * good read to the local snapshot file and falling back to that file when the
 * feed can't be reached, and:
 *   - ranks Dev in Progress tickets by it (sub-issues inherit their parent's rank),
 *   - walks it top to bottom: anything waiting on a person is flagged and
 *     skipped, and the first ready ticket is started (moved to Dev in Progress)
 *     when fewer than `maxInFlight` roadmap tickets are being built.
 */

export interface RoadmapConfig {
  enabled: boolean;
  /** Live feed: GET `{ items: [{ title, link, status, notes }] }` in rank order. Null = snapshot file only. */
  url: string | null;
  /** Bearer token for `url` (ROADMAP_FEED_TOKEN on the team-dsc app). */
  token: string;
  /** Where the roadmap is edited, linked from Symphony's DMs. */
  pageUrl: string | null;
  /** Snapshot file: `{ "source"?: url, "items": [{ title, link, status, notes }] }`. Cache of the feed, and the fallback. */
  file: string;
  /** Start the next ready item automatically. */
  pullReady: boolean;
  /** Max roadmap tickets Symphony builds at once (counted in Dev in Progress). */
  maxInFlight: number;
  /** Linear states a ready item may be pulled from. */
  pullFromStates: string[];
  refreshMs: number;
}

/** `$NAME` → that environment variable (as elsewhere in WORKFLOW.md), else the literal. */
const fromEnv = (value: unknown): string => {
  const s = typeof value === "string" ? value.trim() : "";
  return s.startsWith("$") ? (process.env[s.slice(1)] ?? "").trim() : s;
};

export function parseRoadmapConfig(raw: Record<string, unknown>, baseDir: string): RoadmapConfig {
  const file = typeof raw.file === "string" && raw.file ? raw.file : ".symphony-roadmap.json";
  const url = fromEnv(raw.url) || null;
  return {
    enabled: raw.enabled === true,
    url,
    token: fromEnv(raw.token),
    pageUrl: fromEnv(raw.page_url) || (url ? new URL("/dashboard/roadmap", url).toString() : null),
    file: path.isAbsolute(file) ? file : path.join(baseDir, file),
    pullReady: raw.pull_ready !== false,
    maxInFlight: typeof raw.max_in_flight === "number" && raw.max_in_flight > 0 ? Math.floor(raw.max_in_flight) : 1,
    pullFromStates: Array.isArray(raw.pull_from_states) ? raw.pull_from_states.map(String) : ["Todo", "Backlog"],
    refreshMs: typeof raw.refresh_minutes === "number" && raw.refresh_minutes > 0 ? raw.refresh_minutes * 60_000 : 5 * 60_000,
  };
}

/** Roadmap page statuses. Only "ready" and "build" mean the product side is done; "done" and "cancelled" mean finished. */
export type ItemStatus = "none" | "discovery" | "design" | "ready" | "build" | "blocked" | "done" | "cancelled";

export interface RoadmapItem {
  rank: number;
  title: string;
  link: string;
  identifier: string | null;
  status: ItemStatus;
  notes: string;
}

export interface RoadmapFile {
  source: string | null;
  items: RoadmapItem[];
}

export function identifierFromLink(link: string): string | null {
  const m = /\/issue\/([A-Z][A-Z0-9]*-\d+)/i.exec(link ?? "");
  return m ? m[1].toUpperCase() : null;
}

export function parseRoadmap(json: unknown): RoadmapFile {
  const root = (json && typeof json === "object" ? json : {}) as { source?: unknown; items?: unknown };
  const raw = Array.isArray(root.items) ? root.items : [];
  const items = raw.map((r, i): RoadmapItem => {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const link = typeof o.link === "string" ? o.link.trim() : "";
    const status = String(o.status ?? "none") as ItemStatus;
    return {
      rank: i + 1,
      title: String(o.title ?? "").trim() || "(untitled)",
      link,
      identifier: identifierFromLink(link),
      status: ["none", "discovery", "design", "ready", "build", "blocked", "done", "cancelled"].includes(status) ? status : "none",
      notes: String(o.notes ?? "").trim(),
    };
  });
  return { source: typeof root.source === "string" ? root.source : null, items };
}

export function loadRoadmap(file: string): RoadmapFile | null {
  if (!fs.existsSync(file)) return null;
  return parseRoadmap(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** Read the live feed. Throws on anything but a 200 with an `items` array. */
export async function fetchRoadmap(
  url: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<RoadmapFile> {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`roadmap feed answered ${res.status}`);
  const body = (await res.json()) as { items?: unknown };
  if (!Array.isArray(body?.items)) throw new Error("roadmap feed returned no items");
  return parseRoadmap(body);
}

export interface RoadmapLoad {
  roadmap: RoadmapFile | null;
  from: "feed" | "snapshot" | "none";
  /** Why the feed wasn't used, when it was configured. */
  feedError: string | null;
}

/**
 * The roadmap as of now: the live feed when configured (cached to the snapshot
 * file), else the snapshot. A feed failure falls back to the last good copy so a
 * site outage never reorders or stalls work. `source` is the page to link to.
 */
export async function loadRoadmapLive(rc: RoadmapConfig, fetchImpl: typeof fetch = fetch): Promise<RoadmapLoad> {
  let feedError: string | null = null;
  if (rc.url) {
    if (!rc.token) {
      feedError = "no token (set ROADMAP_FEED_TOKEN)";
    } else {
      try {
        const live = await fetchRoadmap(rc.url, rc.token, fetchImpl);
        const snapshot = {
          source: rc.pageUrl,
          syncedAt: new Date().toISOString(),
          items: live.items.map(({ title, link, status, notes }) => ({ title, link, status, notes })),
        };
        try {
          fs.writeFileSync(rc.file, JSON.stringify(snapshot, null, 2) + "\n");
        } catch {
          // A read-only disk only costs the fallback copy.
        }
        return { roadmap: { ...live, source: rc.pageUrl }, from: "feed", feedError: null };
      } catch (e) {
        feedError = e instanceof Error ? e.message : String(e);
      }
    }
  }
  const snapshot = loadRoadmap(rc.file);
  if (snapshot && rc.pageUrl) snapshot.source = rc.pageUrl;
  return { roadmap: snapshot, from: snapshot ? "snapshot" : "none", feedError };
}

// ─── assessment ──────────────────────────────────────────────────────────────

export interface LinkedIssue {
  id: string;
  identifier: string;
  state: string;
  /** Linear state type: backlog | unstarted | started | completed | canceled | triage */
  stateType: string;
  assignee: string | null;
  labels: string[];
}

export type Verdict = "building" | "next" | "waiting" | "done";

export interface RoadmapEntry {
  rank: number;
  title: string;
  identifier: string | null;
  issueId: string | null;
  verdict: Verdict;
  /** Who it's waiting on (a name), when `verdict` is "waiting". */
  waitingOn: string | null;
  why: string;
}

export interface AssessContext {
  teamKey: string;
  devState: string;
  pullFromStates: string[];
  designPerson: string | null;
  productPerson: string | null;
  /** Name of whoever an open Symphony card for this issue is waiting on, if any. */
  openGateFor: (issueId: string) => string | null;
}

const NOT_READY: Record<string, string> = {
  none: "Not started by product",
  discovery: "In discovery",
  design: "In design",
  blocked: "Blocked",
};

export function assessRoadmap(items: RoadmapItem[], issues: Map<string, LinkedIssue>, ctx: AssessContext): RoadmapEntry[] {
  const lower = (s: string) => s.toLowerCase();
  const pullable = new Set(ctx.pullFromStates.map(lower));
  return items.map(item => {
    const base = { rank: item.rank, title: item.title, identifier: item.identifier, issueId: null as string | null };
    const wait = (who: string | null, why: string): RoadmapEntry => ({ ...base, verdict: "waiting", waitingOn: who, why });

    const issue = item.identifier ? issues.get(item.identifier) : undefined;
    if (issue) base.issueId = issue.id;
    if (issue && (issue.stateType === "completed" || issue.stateType === "canceled")) {
      return { ...base, verdict: "done", waitingOn: null, why: issue.state };
    }
    // Finished on the roadmap itself (shipped or dropped), whatever Linear says.
    if (item.status === "done" || item.status === "cancelled") {
      return { ...base, verdict: "done", waitingOn: null, why: item.status === "done" ? "Done" : "Cancelled" };
    }
    if (item.status !== "ready" && item.status !== "build") {
      const who = item.status === "design" ? ctx.designPerson : ctx.productPerson;
      return wait(who, NOT_READY[item.status] + (item.notes ? ` (${item.notes})` : ""));
    }
    if (!item.identifier) return wait(ctx.productPerson, "Ready for dev but has no Linear ticket");
    if (!item.identifier.startsWith(`${ctx.teamKey.toUpperCase()}-`)) {
      return wait(ctx.productPerson, `Ready for dev but ${item.identifier} isn't a ${ctx.teamKey} ticket yet`);
    }
    if (!issue) return wait(ctx.productPerson, `${item.identifier} not found in Linear`);

    const label = waitingOn(issue.labels);
    if (label) return wait(label, "Waiting on an answer");
    const gate = ctx.openGateFor(issue.id);
    if (gate) return wait(gate, "Waiting on a Symphony card");
    if (lower(issue.state) === lower(ctx.devState)) return { ...base, verdict: "building", waitingOn: null, why: issue.state };
    if (pullable.has(lower(issue.state))) return { ...base, verdict: "next", waitingOn: null, why: issue.state };
    return wait(issue.assignee, issue.state);
  });
}

/** One line per entry, e.g. "#1 Group Admin (TEA-4193): waiting on Silas: Human Dev". */
export function formatEntry(e: RoadmapEntry): string {
  const ref = e.identifier ? ` (${e.identifier})` : "";
  const head = `#${e.rank} ${e.title}${ref}`;
  switch (e.verdict) {
    case "building": return `${head}: Symphony building`;
    case "next": return `${head}: ready to start (${e.why})`;
    case "done": return `${head}: done`;
    case "waiting": return `${head}: waiting on ${e.waitingOn ?? "someone"}: ${e.why}`;
  }
}

/** Rank lookup for dispatch ordering: an issue or its parent on the list. */
export function rankOf(entries: RoadmapEntry[], identifier: string, parentIdentifier?: string | null): number | null {
  for (const e of entries) {
    if (e.identifier && (e.identifier === identifier || e.identifier === parentIdentifier)) return e.rank;
  }
  return null;
}

/** What to start now, if anything: the first ready item while under the in-flight cap. */
export function pickNext(entries: RoadmapEntry[], maxInFlight: number): { next: RoadmapEntry | null; skipped: RoadmapEntry[] } {
  const building = entries.filter(e => e.verdict === "building").length;
  if (building >= maxInFlight) return { next: null, skipped: [] };
  const idx = entries.findIndex(e => e.verdict === "next");
  if (idx < 0) return { next: null, skipped: [] };
  return { next: entries[idx], skipped: entries.slice(0, idx).filter(e => e.verdict === "waiting") };
}

// ─── Linear ──────────────────────────────────────────────────────────────────

const LINKED_ISSUES = `
  query RoadmapIssues($teamKey: String!, $numbers: [Float!]!) {
    issues(filter: { team: { key: { eq: $teamKey } }, number: { in: $numbers } }, first: 100) {
      nodes { id identifier state { name type } assignee { name } labels { nodes { name } } }
    }
  }
`;

export async function fetchLinkedIssues(tracker: TrackerConfig, teamKey: string, identifiers: string[]): Promise<Map<string, LinkedIssue>> {
  const prefix = `${teamKey.toUpperCase()}-`;
  const numbers = identifiers.filter(i => i.startsWith(prefix)).map(i => Number(i.slice(prefix.length)));
  const out = new Map<string, LinkedIssue>();
  if (numbers.length === 0) return out;
  const data = (await executeGraphQL(tracker, LINKED_ISSUES, { teamKey, numbers })) as {
    issues: { nodes: Array<{ id: string; identifier: string; state: { name: string; type: string } | null; assignee: { name: string } | null; labels: { nodes: Array<{ name: string }> } }> };
  };
  for (const n of data.issues?.nodes ?? []) {
    out.set(n.identifier.toUpperCase(), {
      id: n.id,
      identifier: n.identifier,
      state: n.state?.name ?? "",
      stateType: n.state?.type ?? "",
      assignee: n.assignee?.name ?? null,
      labels: n.labels.nodes.map(l => l.name.toLowerCase()),
    });
  }
  return out;
}

// ─── CLI: npm run roadmap -- <saved page .html|.json> [page url] ─────────────

/** Pull the roadmap state out of a saved copy of the roadmap page (its `<script id="state">` JSON) or a plain JSON file. */
export function extractRoadmapJson(text: string): unknown {
  const m = /<script[^>]*id="state"[^>]*>([\s\S]*?)<\/script>/.exec(text);
  return JSON.parse(m ? m[1] : text);
}

function cli(args: string[]): void {
  const [input, source] = args;
  if (!input) {
    console.error("usage: npm run roadmap -- <saved roadmap page .html|.json> [page url]");
    process.exit(1);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const parsed = parseRoadmap(extractRoadmapJson(fs.readFileSync(input, "utf8")));
  const out = path.join(root, ".symphony-roadmap.json");
  const previous = loadRoadmap(out);
  const snapshot = {
    source: source ?? previous?.source ?? null,
    syncedAt: new Date().toISOString(),
    items: parsed.items.map(({ title, link, status, notes }) => ({ title, link, status, notes })),
  };
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`Wrote ${parsed.items.length} roadmap items to ${out}`);
  for (const i of parsed.items) console.log(`  #${i.rank} ${i.title}${i.identifier ? ` (${i.identifier})` : ""} [${i.status}]`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2));
}
