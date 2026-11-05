import * as fs from "node:fs";
import { classifyDiff } from "./diff-risk.js";
import type { GitHubClient, PrInfo } from "./github.js";
import type { GateHub } from "./gate-hub.js";
import type { GateResolution } from "./gates.js";
import * as linear from "./linear.js";
import { fetchIssuesInState, setIssueState, type StateIssue } from "./linear-ops.js";
import { AI_COMMENT_MARKER } from "./rework-cleanup.js";
import type { GateImage, GateLink, Logger, TrackerConfig } from "./types.js";

/**
 * Review flow — picks up tickets the agent moved to `In Review`:
 *
 *   checks pending        → wait
 *   CI failing / AI review says `changes` → send back automatically (≤ N times) with the
 *                           failure as the rework brief — no human sees it
 *   low risk + non-UI + green + auto-merge on + kill switch off → merge (deploy guard watches)
 *   otherwise             → one card: visual sign-off (UI) or code review
 *
 * A card's approve merges; reject moves the ticket back for rework (the hub's
 * decision comment, with the note, becomes the `## Fix` brief).
 */

export interface ReviewFlowConfig {
  teamKey: string;
  reviewState: string;
  reworkState: string;
  /** State after merge; null = leave it to Linear's GitHub integration. */
  mergedState: string | null;
  autoMerge: boolean;
  killSwitchPath: string;
  maxAutoSendBacks: number;
  statePath: string;
}

export interface MergedInfo {
  issueId: string;
  identifier: string;
  pr: PrInfo;
}

interface FlowState {
  sendBacks: Record<string, number>;
}

export interface DeliveryInfo {
  summary: string | null;
  checked: string | null;
  notChecked: string | null;
  images: GateImage[];
}

/** Pull summary / Checked / Not checked / screenshots out of the agent's delivery comment. */
export function parseDelivery(comments: linear.LinearComment[]): DeliveryInfo {
  const delivery = [...comments].reverse().find(c => c.body.includes(AI_COMMENT_MARKER) && /Ready for review/i.test(c.body));
  const empty: DeliveryInfo = { summary: null, checked: null, notChecked: null, images: [] };
  if (!delivery) return empty;
  const lines = delivery.body.split("\n").map(l => l.trim());
  const heading = lines.findIndex(l => /Ready for review/i.test(l));
  const summary = lines.slice(heading + 1).find(l => l && !l.startsWith("**") && !l.startsWith("!") && !l.startsWith("-") && !/^(PR|Preview|Linear):/i.test(l)) ?? null;
  const field = (name: string) => {
    const l = lines.find(x => new RegExp(`^\\*\\*${name}:\\*\\*`, "i").test(x));
    return l ? l.replace(new RegExp(`^\\*\\*${name}:\\*\\*\\s*`, "i"), "") : null;
  };
  const images = [...delivery.body.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)].map(m => ({ label: m[1] || "Screenshot", url: m[2] }));
  return { summary, checked: field("Checked"), notChecked: field("Not checked"), images };
}

/** Latest AI review verdict posted on the PR (see templates/github/claude-review.yml). */
export function parseReviewVerdict(comments: Array<{ body: string }>): { verdict: "approve" | "changes"; findings: string[] } | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const m = /Verdict:\s*(approve|changes)/i.exec(comments[i].body);
    if (m) {
      const findings = comments[i].body.split("\n").map(l => l.trim()).filter(l => /^(BLOCKER|FIX):/i.test(l));
      return { verdict: m[1].toLowerCase() as "approve" | "changes", findings };
    }
  }
  return null;
}

export function findPreviewUrl(comments: Array<{ body: string }>): string | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const m = /https:\/\/[a-z0-9-]+\.onrender\.com[^\s)>\]]*/i.exec(comments[i].body);
    if (m) return m[0].replace(/\/health-check\/?$/, "");
  }
  return null;
}

export class ReviewFlow {
  private readonly cfg: ReviewFlowConfig;
  private readonly tracker: TrackerConfig;
  private readonly hub: GateHub;
  private readonly gh: GitHubClient;
  private readonly log: Logger;
  private readonly onMerged: (m: MergedInfo) => void;
  private state: FlowState = { sendBacks: {} };
  private busy = false;

  constructor(cfg: ReviewFlowConfig, tracker: TrackerConfig, hub: GateHub, gh: GitHubClient, log: Logger, onMerged: (m: MergedInfo) => void) {
    this.cfg = cfg;
    this.tracker = tracker;
    this.hub = hub;
    this.gh = gh;
    this.log = log;
    this.onMerged = onMerged;
    this.load();
    hub.onKind("code_review", r => this.onDecision(r));
    hub.onKind("visual_signoff", r => this.onDecision(r));
  }

  killSwitchOn(): boolean {
    return fs.existsSync(this.cfg.killSwitchPath);
  }

  async reconcile(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const issues = await fetchIssuesInState(this.tracker, this.cfg.teamKey, this.cfg.reviewState);
      for (const issue of issues) {
        try {
          await this.reviewOne(issue);
        } catch (e) {
          this.log.warn("Review flow failed for issue", { issue: issue.identifier, error: e instanceof Error ? e.message : String(e) });
        }
      }
    } catch (e) {
      this.log.warn("Review flow poll failed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.busy = false;
    }
  }

  private async reviewOne(issue: StateIssue): Promise<void> {
    if (this.hub.store.openFor(issue.id).length > 0) return;
    // Only Symphony-built tickets (they carry the agent's marked delivery comment) —
    // never auto-merge or send back a teammate's own PR.
    const issueComments = await linear.fetchIssueCommentsDetail(this.tracker, issue.id);
    if (!issueComments.some(c => c.body.includes(AI_COMMENT_MARKER))) return;
    const prUrl = await linear.fetchIssuePrUrl(this.tracker, issue.id);
    if (!prUrl) return;
    const pr = await this.gh.getPr(prUrl);
    if (pr.state === "MERGED") {
      if (this.cfg.mergedState) await setIssueState(this.tracker, issue.id, this.cfg.mergedState);
      return;
    }
    if (pr.state === "CLOSED" || pr.isDraft || pr.checks.pending > 0) return;

    const prComments = await this.gh.listPrComments(prUrl, 30);
    const review = parseReviewVerdict(prComments);
    const failing = pr.checks.failing > 0;
    const reviewSaysChanges = review?.verdict === "changes";
    const sendBacks = this.state.sendBacks[issue.id] ?? 0;

    if ((failing || reviewSaysChanges || pr.mergeable === "CONFLICTING") && sendBacks < this.cfg.maxAutoSendBacks) {
      const why: string[] = [];
      if (failing) why.push(`CI failing: ${pr.checks.failingNames.join(", ") || "see PR checks"}. Fix the cause; don't skip or disable checks.`);
      if (reviewSaysChanges) why.push("Automated review asked for changes:", ...(review?.findings.length ? review.findings.map(f => `- ${f}`) : ["- see the review comment on the PR"]));
      if (pr.mergeable === "CONFLICTING") why.push("Merge conflict with main — rebase and resolve.");
      await linear.addComment(this.tracker, issue.id, `↩️ Sent back automatically (${sendBacks + 1}/${this.cfg.maxAutoSendBacks})\n\n${why.join("\n")}`);
      await setIssueState(this.tracker, issue.id, this.cfg.reworkState);
      this.state.sendBacks[issue.id] = sendBacks + 1;
      this.persist();
      this.log.info("Review flow: sent back", { issue: issue.identifier, failing, review: review?.verdict ?? "none" });
      return;
    }

    const risk = classifyDiff(pr.files, { additions: pr.additions, deletions: pr.deletions });
    const green = !failing && !reviewSaysChanges && pr.mergeable === "MERGEABLE";

    if (green && !risk.ui && risk.risk === "low" && this.cfg.autoMerge && !this.killSwitchOn()) {
      await this.merge(issue.id, issue.identifier, pr, `Auto-merged: low risk (${risk.reasons.join("; ") || "small, safe change"}), checks green.`);
      return;
    }

    const delivery = parseDelivery(issueComments);
    const preview = findPreviewUrl(prComments);
    const links: GateLink[] = [{ label: `PR #${pr.number}`, url: pr.url }, { label: "Diff", url: `${pr.url}/files` }];
    if (preview) links.push({ label: "Preview", url: preview });
    links.push({ label: issue.identifier, url: issue.url });

    const why = [
      `Risk: ${risk.risk}${risk.reasons.length ? ` (${risk.reasons.slice(0, 3).join("; ")})` : ""}.`,
      failing ? `⚠️ CI still failing after ${sendBacks} auto-fix tries: ${pr.checks.failingNames.join(", ")}.` : "Checks green.",
      review ? `AI review: ${review.verdict}.` : "",
    ].filter(Boolean).join(" ");
    const summary = [
      delivery.summary ?? issue.title,
      delivery.checked ? `Checked: ${delivery.checked}` : "",
      delivery.notChecked ? `Not checked: ${delivery.notChecked}` : "Not checked: (agent didn't say — look closely)",
      why,
    ].filter(Boolean).join("\n");

    const ui = risk.ui;
    await this.hub.open({
      kind: ui ? "visual_signoff" : "code_review",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      title: `${issue.identifier} ${issue.title}`.slice(0, 120),
      summary,
      question: ui ? "Does the preview match the design?" : "Merge this?",
      links,
      images: delivery.images,
      meta: { prUrl: pr.url, risk: risk.risk, ...(preview ? { previewUrl: preview } : {}) },
    });
  }

  private async onDecision(r: GateResolution): Promise<void> {
    const { gate, decision } = r;
    const prUrl = gate.meta?.prUrl;
    if (!gate.issueId || !prUrl) return;
    if (decision.actionKind === "reject") {
      await setIssueState(this.tracker, gate.issueId, this.cfg.reworkState);
      return;
    }
    if (decision.actionKind !== "approve") return;
    const pr = await this.gh.getPr(prUrl);
    if (pr.state !== "OPEN") return;
    // A UI sign-off on a high-risk diff still needs a code review before merge.
    if (gate.kind === "visual_signoff" && gate.meta?.risk === "high") {
      await this.hub.open({
        kind: "code_review", issueId: gate.issueId, issueIdentifier: gate.issueIdentifier,
        title: gate.title, summary: `Design approved. High-risk diff — needs a code look before merge.\n${gate.summary}`,
        question: "Merge this?", links: gate.links, meta: { prUrl, risk: "high" }, forwardTo: null,
      });
      return;
    }
    await this.merge(gate.issueId, gate.issueIdentifier ?? "", pr, null);
  }

  private async merge(issueId: string, identifier: string, pr: PrInfo, note: string | null): Promise<void> {
    await this.gh.mergePr(pr.url, "squash");
    if (note) await linear.addComment(this.tracker, issueId, `✅ ${note}\n\n${pr.url}`);
    if (this.cfg.mergedState) await setIssueState(this.tracker, issueId, this.cfg.mergedState).catch(() => false);
    delete this.state.sendBacks[issueId];
    this.persist();
    this.log.info("Review flow: merged", { issue: identifier, pr: pr.url, auto: note !== null });
    this.onMerged({ issueId, identifier, pr: { ...pr, mergedAt: new Date().toISOString(), state: "MERGED" } });
  }

  private load(): void {
    try {
      this.state = { sendBacks: {}, ...JSON.parse(fs.readFileSync(this.cfg.statePath, "utf8")) };
    } catch {
      // fresh
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.cfg.statePath, JSON.stringify(this.state, null, 2));
    } catch {
      // best effort
    }
  }
}
