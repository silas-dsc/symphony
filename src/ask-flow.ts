import type { GateHub } from "./gate-hub.js";
import * as linear from "./linear.js";
import { fetchIssuesWithLabelPrefix, latestWithMarker } from "./linear-ops.js";
import type { GateAction, GateKind, Logger, TrackerConfig } from "./types.js";

/**
 * Ask flow — turns an agent's question into a card.
 *
 * The agent posts a comment starting `<!-- symphony-ask:<kind> -->` with a
 * question and `- **A:** …` options, labels the issue `waiting-on:<person>`
 * and stops. This opens one card with a button per option. The hub's decision
 * comment (e.g. "✅ A: Use the existing table") becomes the rework brief, and
 * removing the label lets the governor dispatch the ticket again.
 */

export const ASK_MARKER = "symphony-ask";
const ASK_KINDS: GateKind[] = ["approve_approach", "product_decision", "login_credential"];

export interface ParsedAsk {
  kind: GateKind;
  question: string;
  options: Array<{ key: string; text: string }>;
}

export function parseAsk(body: string): ParsedAsk | null {
  const m = new RegExp(`<!--\\s*${ASK_MARKER}:([a-z_]+)\\s*-->`).exec(body);
  if (!m) return null;
  const kind = (ASK_KINDS as string[]).includes(m[1]) ? (m[1] as GateKind) : "approve_approach";
  const q = /\*\*Question:\*\*\s*(.+)/i.exec(body);
  const options = [...body.matchAll(/^\s*-\s*\*\*([A-Z]):\*\*\s*(.+)$/gm)].map(o => ({ key: o[1], text: o[2].trim() }));
  return { kind, question: q ? q[1].trim() : "The agent needs a decision.", options };
}

export function askActions(ask: ParsedAsk): GateAction[] {
  if (ask.kind === "login_credential") {
    return [
      { id: "done", label: "Done", kind: "approve", primary: true },
      { id: "cant", label: "Can't now", kind: "reject" },
    ];
  }
  const opts: GateAction[] = ask.options.slice(0, 4).map((o, i) => ({
    id: `option_${o.key.toLowerCase()}`,
    label: `${o.key}: ${o.text.replace(/\s*\(recommended\)\s*/i, "")}`.slice(0, 70),
    kind: "approve",
    primary: i === 0 || /\(recommended\)/i.test(o.text),
  }));
  if (opts.length === 0) opts.push({ id: "approve", label: "Go ahead", kind: "approve", primary: true });
  opts.push({ id: "other", label: "Something else", kind: "neutral" });
  return opts;
}

export class AskFlow {
  constructor(
    private readonly teamKey: string,
    private readonly tracker: TrackerConfig,
    private readonly hub: GateHub,
    private readonly log: Logger,
  ) {}

  async reconcile(): Promise<void> {
    let issues;
    try {
      issues = await fetchIssuesWithLabelPrefix(this.tracker, this.teamKey, "waiting-on:");
    } catch (e) {
      this.log.warn("Ask flow poll failed", { error: e instanceof Error ? e.message : String(e) });
      return;
    }
    for (const issue of issues) {
      if (this.hub.store.openFor(issue.id).length > 0) continue;
      try {
        const comments = await linear.fetchIssueCommentsDetail(this.tracker, issue.id);
        const askComment = latestWithMarker(comments, `${ASK_MARKER}:`);
        if (!askComment) continue;
        // Already answered? (a decision comment newer than the ask)
        const answered = comments.some(c => c.createdAt > askComment.createdAt && c.body.includes("<!-- symphony-gate:"));
        if (answered) continue;
        const ask = parseAsk(askComment.body);
        if (!ask) continue;
        await this.hub.open({
          kind: ask.kind,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          title: `${issue.identifier} ${issue.title}`.slice(0, 120),
          summary: ask.options.map(o => `${o.key}: ${o.text}`).join("\n") || "See the ticket.",
          question: ask.question,
          links: [{ label: issue.identifier, url: issue.url }],
          actions: askActions(ask),
        });
      } catch (e) {
        this.log.warn("Ask flow failed for issue", { issue: issue.identifier, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
}
