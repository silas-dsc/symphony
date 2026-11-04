import * as fs from "node:fs";
import type { GitHubClient, PrInfo } from "./github.js";
import type { GateHub } from "./gate-hub.js";
import * as linear from "./linear.js";
import type { Logger, TrackerConfig } from "./types.js";

/**
 * Deploy guard: after a merge, wait `watchMinutes`, then compare production
 * error signatures in the window after the merge with the same-length window
 * before it. A signature that is new (absent before, ≥ minOccurrences after)
 * opens a revert PR and a one-click "Merge revert" card for the operator.
 *
 * Error sources are injected (Firebase via gcloud, Render via its API) so the
 * guard stays testable and works with whichever sources are configured.
 */

export type ErrorSource = (sinceIso: string, untilIso: string) => Promise<Map<string, number>>;

export interface DeployGuardConfig {
  watchMinutes: number;
  minNewOccurrences: number;
  statePath: string;
}

interface Watch {
  issueId: string;
  identifier: string;
  pr: PrInfo;
  mergedAt: string;
}

export function newSignatures(before: Map<string, number>, after: Map<string, number>, minCount: number): Array<[string, number]> {
  return [...after.entries()].filter(([sig, n]) => n >= minCount && !before.has(sig)).sort((a, b) => b[1] - a[1]);
}

export class DeployGuard {
  private watches: Watch[] = [];
  private busy = false;

  constructor(
    private readonly cfg: DeployGuardConfig,
    private readonly tracker: TrackerConfig,
    private readonly sources: ErrorSource[],
    private readonly gh: GitHubClient,
    private readonly hub: GateHub,
    private readonly log: Logger,
  ) {
    try {
      this.watches = JSON.parse(fs.readFileSync(cfg.statePath, "utf8")) as Watch[];
    } catch {
      this.watches = [];
    }
    hub.onKind("merge_deploy", async r => {
      const revertUrl = r.gate.meta?.revertUrl;
      if (r.decision.actionKind === "approve" && revertUrl) await this.gh.mergePr(revertUrl, "squash");
    });
  }

  track(issueId: string, identifier: string, pr: PrInfo): void {
    if (this.sources.length === 0) return;
    this.watches.push({ issueId, identifier, pr, mergedAt: pr.mergedAt ?? new Date().toISOString() });
    this.persist();
  }

  pending(): number {
    return this.watches.length;
  }

  async reconcile(now = Date.now()): Promise<void> {
    if (this.busy || this.watches.length === 0) return;
    this.busy = true;
    try {
      const windowMs = this.cfg.watchMinutes * 60_000;
      const due = this.watches.filter(w => Date.parse(w.mergedAt) + windowMs <= now);
      for (const w of due) {
        try {
          await this.check(w, windowMs);
        } catch (e) {
          this.log.warn("Deploy guard check failed", { issue: w.identifier, error: e instanceof Error ? e.message : String(e) });
        }
        this.watches = this.watches.filter(x => x !== w);
        this.persist();
      }
    } finally {
      this.busy = false;
    }
  }

  private async check(w: Watch, windowMs: number): Promise<void> {
    const merged = Date.parse(w.mergedAt);
    const iso = (t: number) => new Date(t).toISOString();
    const before = new Map<string, number>();
    const after = new Map<string, number>();
    for (const source of this.sources) {
      for (const [sig, n] of await source(iso(merged - windowMs), iso(merged))) before.set(sig, (before.get(sig) ?? 0) + n);
      for (const [sig, n] of await source(iso(merged), iso(merged + windowMs))) after.set(sig, (after.get(sig) ?? 0) + n);
    }
    const fresh = newSignatures(before, after, this.cfg.minNewOccurrences);
    if (fresh.length === 0) {
      this.log.info("Deploy guard: clean", { issue: w.identifier });
      return;
    }
    const list = fresh.slice(0, 5).map(([sig, n]) => `- ${n}× ${sig.slice(0, 160)}`).join("\n");
    const revertUrl = await this.gh.createRevertPr(w.pr, `New production errors within ${this.cfg.watchMinutes} min of merging:\n${list}`);
    await quiet(() => linear.addComment(this.tracker, w.issueId, `⚠️ New errors after this merged — revert PR ready: ${revertUrl}\n\n${list}`));
    await this.hub.open({
      kind: "merge_deploy",
      issueId: w.issueId,
      issueIdentifier: w.identifier,
      title: `New errors after ${w.identifier} — revert?`,
      summary: `${fresh.length} new error type(s) started after this merged:\n${list}`,
      question: "Merge the revert?",
      links: [{ label: "Revert PR", url: revertUrl }, { label: "Original PR", url: w.pr.url }],
      actions: [
        { id: "merge_revert", label: "Merge revert", kind: "approve", primary: true },
        { id: "keep", label: "Keep — not caused by this", kind: "reject" },
      ],
      meta: { revertUrl, prUrl: w.pr.url },
      forwardTo: null,
    });
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.cfg.statePath, JSON.stringify(this.watches, null, 2));
    } catch {
      // best effort
    }
  }
}

/** Best-effort side effect: never throws. */
async function quiet(fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch {
    // ignore
  }
}
