import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GateHub } from "./gate-hub.js";
import type { GateResolution } from "./gates.js";
import type { GitHubClient } from "./github.js";
import type { GateLink, Logger } from "./types.js";

const execFileP = promisify(execFile);

/**
 * Teammates' PRs waiting on the operator's review → one Slack card each, with
 * the PR, its Linear ticket, the Render preview, and buttons:
 *   Approve on GitHub · Request changes · 🧪 Functional test
 * Approving submits a GitHub review; it never merges someone else's PR.
 * The card goes away when the PR is merged, closed, or no longer asks for review.
 */

export interface RequestedPr {
  url: string;
  number: number;
  title: string;
  author: string;
}

export interface ReviewRequestsConfig {
  repo: string;
  /** e.g. https://team-dsc-production-preview-web-pr-{{pr}}.onrender.com */
  previewTemplate: string | null;
  linearWorkspaceUrl: string | null;
  intervalMs: number;
  /** Most review cards open at once (flood guard). */
  maxOpen: number;
}

/** First TEA-123-style ticket key in a PR title or branch. */
export function ticketKeyFrom(...texts: string[]): string | null {
  for (const t of texts) {
    const m = /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/i.exec(t ?? "");
    if (m) return `${m[1].toUpperCase()}-${m[2]}`;
  }
  return null;
}

export function previewUrlFor(template: string | null, prNumber: number): string | null {
  return template ? template.replace(/\{\{\s*pr\s*\}\}/g, String(prNumber)).replace(/\/health-check\/?$/, "") : null;
}

export class ReviewRequests {
  private last = 0;
  private busy = false;

  constructor(
    private readonly cfg: ReviewRequestsConfig,
    private readonly hub: GateHub,
    private readonly gh: GitHubClient,
    private readonly log: Logger,
    private readonly listRequested: () => Promise<RequestedPr[]> = () => searchReviewRequested(cfg.repo),
    private readonly review: (prUrl: string, kind: "approve" | "request-changes", body: string) => Promise<void> = ghReview,
  ) {
    hub.onKind("pr_review", r => this.onDecision(r));
  }

  async reconcile(now = Date.now()): Promise<void> {
    if (this.busy || now - this.last < this.cfg.intervalMs) return;
    this.busy = true;
    this.last = now;
    try {
      const requested = await this.listRequested();
      const wanted = new Set(requested.map(p => p.url));
      const open = this.hub.store.openGates().filter(g => g.kind === "pr_review");
      for (const g of open) {
        if (g.meta?.prUrl && !wanted.has(g.meta.prUrl)) await this.hub.dismissGate(g.id, "no longer waiting on your review");
      }
      const have = new Set(open.map(g => g.meta?.prUrl));
      let openNow = open.filter(g => g.meta?.prUrl && wanted.has(g.meta.prUrl)).length;
      for (const pr of requested) {
        if (have.has(pr.url)) continue;
        if (openNow >= this.cfg.maxOpen) break;
        openNow++;
        await this.openCard(pr).catch(e => this.log.warn("Review request card failed", { pr: pr.url, error: e instanceof Error ? e.message : String(e) }));
      }
    } catch (e) {
      this.log.warn("Review requests poll failed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.busy = false;
    }
  }

  private async openCard(req: RequestedPr): Promise<void> {
    const pr = await this.gh.getPr(req.url);
    const key = ticketKeyFrom(req.title, pr.headRefName);
    const preview = previewUrlFor(this.cfg.previewTemplate, pr.number);
    const links: GateLink[] = [{ label: `PR #${pr.number}`, url: pr.url }, { label: "Diff", url: `${pr.url}/files` }];
    if (key && this.cfg.linearWorkspaceUrl) links.push({ label: key, url: `${this.cfg.linearWorkspaceUrl}/issue/${key}` });
    if (preview) links.push({ label: "Preview", url: preview });
    const checks = pr.checks.failing > 0 ? `⚠️ Failing: ${pr.checks.failingNames.join(", ")}` : pr.checks.pending > 0 ? "Checks running" : "Checks green";
    await this.hub.open({
      kind: "pr_review",
      title: `${req.author}: ${req.title}`.slice(0, 120),
      summary: [`${req.author} asked for your review. +${pr.additions}/−${pr.deletions} in ${pr.files.length} files.`, checks].join("\n"),
      question: "Approve this PR?",
      links,
      meta: { prUrl: pr.url, ...(key ? { ticket: key } : {}), ...(preview ? { previewUrl: preview } : {}) },
      forwardTo: null,
    });
    this.log.info("Review request card opened", { pr: pr.url, ticket: key ?? "none" });
  }

  private async onDecision(r: GateResolution): Promise<void> {
    const prUrl = r.gate.meta?.prUrl;
    if (!prUrl) return;
    const by = r.decision.by ?? "the operator";
    if (r.decision.actionKind === "approve") {
      await this.review(prUrl, "approve", `Approved by ${by} via Symphony.`);
    } else if (r.decision.actionKind === "reject") {
      await this.review(prUrl, "request-changes", r.decision.note ?? `${by} requested changes (via Symphony). Details to follow.`);
    }
  }
}

async function searchReviewRequested(repo: string): Promise<RequestedPr[]> {
  const { stdout } = await execFileP("gh", [
    "search", "prs", "--review-requested=@me", "--state=open", `--repo=${repo}`,
    "--json", "url,number,title,author", "--limit", "30",
  ], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  const rows = JSON.parse(stdout) as Array<{ url: string; number: number; title: string; author?: { login?: string } }>;
  return rows.map(r => ({ url: r.url, number: r.number, title: r.title, author: r.author?.login ?? "someone" }));
}

async function ghReview(prUrl: string, kind: "approve" | "request-changes", body: string): Promise<void> {
  await execFileP("gh", ["pr", "review", prUrl, `--${kind}`, "--body", body], { timeout: 60_000 });
}
