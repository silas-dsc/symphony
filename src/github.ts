/**
 * Thin `gh`-CLI-backed GitHub client for the v2 orchestrator: read a PR (state,
 * mergeability, files, checks), merge it, open a revert PR, and read its
 * comments. Behind an interface so callers can fake it in tests.
 *
 * Shells out the same way as `github-preview.ts` / `merge-conflict.ts`:
 * `execFile` (no shell), explicit timeout, bounded buffer.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "./types.js";

const execFileP = promisify(execFile);

export type PrState = "OPEN" | "MERGED" | "CLOSED";
export type PrMergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export interface PrChecks {
  passing: number;
  failing: number;
  pending: number;
  failingNames: string[];
}

export interface PrInfo {
  url: string;
  number: number;
  owner: string;
  repo: string;
  state: PrState;
  isDraft: boolean;
  headRefName: string;
  mergeable: PrMergeable;
  additions: number;
  deletions: number;
  files: string[];
  checks: PrChecks;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  nodeId: string;
}

export interface PrComment {
  body: string;
  createdAt: string;
}

export interface GitHubClient {
  getPr(prUrl: string): Promise<PrInfo>;
  mergePr(prUrl: string, method?: "squash" | "merge"): Promise<void>;
  /** Opens a revert PR via GitHub's `revertPullRequest` mutation. Returns the new PR url. */
  createRevertPr(pr: PrInfo, reason: string): Promise<string>;
  /** Most recent `limit` comments, oldest first. */
  listPrComments(prUrl: string, limit?: number): Promise<PrComment[]>;
}

/** Parses `https://github.com/<owner>/<repo>/pull/<n>` (trailing path/query/hash allowed). */
export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  if (!url) return null;
  const m = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[\/?#].*)?$/i
    .exec(url.trim());
  if (!m) return null;
  const number = Number.parseInt(m[3], 10);
  if (!Number.isFinite(number) || number <= 0) return null;
  return { owner: m[1], repo: m[2], number };
}

/** One entry of `gh pr view --json statusCheckRollup`: a CheckRun or a StatusContext. */
export interface RollupEntry {
  __typename?: string;
  name?: string | null;
  context?: string | null;
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
}

const FAILING_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const FAILING_STATES = new Set(["FAILURE", "ERROR"]);
const PENDING_STATES = new Set(["PENDING", "EXPECTED"]);

/**
 * Collapses a statusCheckRollup into counts. Pending wins over failing (a
 * still-running check has no conclusion yet). Anything else — SUCCESS,
 * SKIPPED, NEUTRAL, STALE — counts as passing.
 */
export function summariseChecks(rollup: RollupEntry[] | null | undefined): PrChecks {
  const out: PrChecks = { passing: 0, failing: 0, pending: 0, failingNames: [] };
  if (!Array.isArray(rollup)) return out;
  for (const entry of rollup) {
    if (!entry || typeof entry !== "object") continue;
    const status = upper(entry.status);
    const conclusion = upper(entry.conclusion);
    const state = upper(entry.state);
    const name = entry.name || entry.context || "(unnamed check)";

    // CheckRuns carry `status`; StatusContexts carry `state` only.
    const isPending = (status !== "" && status !== "COMPLETED") || PENDING_STATES.has(state);
    if (isPending) {
      out.pending++;
      continue;
    }
    if (FAILING_CONCLUSIONS.has(conclusion) || FAILING_STATES.has(state)) {
      out.failing++;
      out.failingNames.push(name);
      continue;
    }
    out.passing++;
  }
  return out;
}

/** Raw shape of `gh pr view --json <PR_VIEW_FIELDS>`. */
export interface RawPrView {
  url?: string;
  number?: number;
  state?: string;
  isDraft?: boolean;
  headRefName?: string;
  mergeable?: string;
  additions?: number;
  deletions?: number;
  files?: Array<{ path?: string }> | null;
  statusCheckRollup?: RollupEntry[] | null;
  mergedAt?: string | null;
  mergeCommit?: { oid?: string | null } | null;
  id?: string;
}

export const PR_VIEW_FIELDS = [
  "url", "number", "state", "isDraft", "headRefName", "mergeable", "additions", "deletions",
  "files", "statusCheckRollup", "mergedAt", "mergeCommit", "id",
].join(",");

/** Pure mapping from `gh pr view` JSON to PrInfo. Exported for tests. */
export function toPrInfo(raw: RawPrView, requestedUrl: string): PrInfo {
  const url = raw.url || requestedUrl;
  const parsed = parsePrUrl(url) ?? parsePrUrl(requestedUrl);
  if (!parsed) throw new Error(`Not a GitHub PR url: ${url}`);
  const state = upper(raw.state);
  const mergeable = upper(raw.mergeable);
  return {
    url,
    number: typeof raw.number === "number" ? raw.number : parsed.number,
    owner: parsed.owner,
    repo: parsed.repo,
    state: state === "MERGED" || state === "CLOSED" ? state : "OPEN",
    isDraft: raw.isDraft === true,
    headRefName: raw.headRefName ?? "",
    mergeable: mergeable === "MERGEABLE" || mergeable === "CONFLICTING" ? mergeable : "UNKNOWN",
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    files: (raw.files ?? []).map(f => f?.path).filter((p): p is string => typeof p === "string" && p.length > 0),
    checks: summariseChecks(raw.statusCheckRollup),
    mergedAt: raw.mergedAt || null,
    mergeCommitSha: raw.mergeCommit?.oid || null,
    nodeId: raw.id ?? "",
  };
}

const REVERT_MUTATION = `mutation($id: ID!, $title: String!, $body: String!) {
  revertPullRequest(input: { pullRequestId: $id, title: $title, body: $body }) {
    revertPullRequest { url number }
  }
}`;

export class GhCliClient implements GitHubClient {
  constructor(private readonly log: Logger, private readonly timeoutMs = 60_000) {}

  async getPr(prUrl: string): Promise<PrInfo> {
    requirePrUrl(prUrl);
    const stdout = await this.gh(["pr", "view", prUrl, "--json", PR_VIEW_FIELDS]);
    return toPrInfo(JSON.parse(stdout) as RawPrView, prUrl);
  }

  async mergePr(prUrl: string, method: "squash" | "merge" = "squash"): Promise<void> {
    requirePrUrl(prUrl);
    await this.gh(["pr", "merge", prUrl, method === "merge" ? "--merge" : "--squash", "--delete-branch"]);
    this.log.info("Merged PR", { pr_url: prUrl, method });
  }

  async createRevertPr(pr: PrInfo, reason: string): Promise<string> {
    if (!pr.nodeId) throw new Error(`PR ${pr.url} has no node id; cannot revert`);
    const title = `Revert #${pr.number}${pr.headRefName ? ` (${pr.headRefName})` : ""}`;
    const body = [
      `Reverts ${pr.url}.`,
      "",
      `**Why:** ${reason.trim() || "auto-deploy watch flagged a regression"}`,
      "",
      "_Opened automatically by Symphony._",
    ].join("\n");
    const stdout = await this.gh([
      "api", "graphql",
      "-f", `query=${REVERT_MUTATION}`,
      "-f", `id=${pr.nodeId}`,
      "-f", `title=${title}`,
      "-f", `body=${body}`,
    ]);
    const payload = JSON.parse(stdout) as {
      data?: { revertPullRequest?: { revertPullRequest?: { url?: string } | null } | null };
      errors?: Array<{ message?: string }>;
    };
    const url = payload.data?.revertPullRequest?.revertPullRequest?.url;
    if (!url) {
      const msg = payload.errors?.map(e => e.message).filter(Boolean).join("; ") || "no PR url returned";
      throw new Error(`revertPullRequest failed for ${pr.url}: ${msg}`);
    }
    this.log.warn("Opened revert PR", { pr_url: pr.url, revert_url: url, reason });
    return url;
  }

  async listPrComments(prUrl: string, limit = 20): Promise<PrComment[]> {
    requirePrUrl(prUrl);
    const stdout = await this.gh(["pr", "view", prUrl, "--json", "comments"]);
    const payload = JSON.parse(stdout) as { comments?: Array<{ body?: string; createdAt?: string }> };
    const comments = (payload.comments ?? [])
      .filter(c => c && typeof c.body === "string")
      .map(c => ({ body: c.body as string, createdAt: c.createdAt ?? "" }));
    return limit > 0 ? comments.slice(-limit) : comments;
  }

  private async gh(args: string[]): Promise<string> {
    const { stdout } = await execFileP("gh", args, {
      env: process.env,
      encoding: "utf8",
      timeout: this.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  }
}

function requirePrUrl(url: string): void {
  if (!parsePrUrl(url)) throw new Error(`Not a GitHub PR url: ${url}`);
}

function upper(v: string | null | undefined): string {
  return typeof v === "string" ? v.toUpperCase() : "";
}
