import { GateStore, type GateResolution } from "./gates.js";
import { buildGateBlocks, buildResolvedBlocks, parseDraftAction, parseGateActionValue } from "./gate-slack.js";
import { openDm, postMessage, updateMessage } from "./slack-api.js";
import type { SlackAction } from "./slack-socket.js";
import * as linear from "./linear.js";
import { addIssueLabel, getIssueContext, removeIssueLabel, resolveUserId, setIssueAssignee } from "./linear-ops.js";
import { AI_COMMENT_MARKER } from "./rework-cleanup.js";
import type { Gate, GateInput, GateKind, Logger, TrackerConfig } from "./types.js";

/**
 * The human gate hub: opens one-click cards where people already are and
 * applies their decisions.
 *
 * - **Slack:** a DM card with buttons (Socket Mode — no public URL needed).
 * - **Linear:** a card comment + `waiting-on:<person>` label (+ assignment for
 *   non-operators), so a "Waiting on me" view is each person's queue. Replying
 *   `approve` / `send back: <note>` on the ticket also resolves the card.
 * - **Routing:** design and product gates go to the operator first with an
 *   "Ask <name>" button, keeping Nika's and Evie's queues as small as possible.
 */

export const GATE_CARD_MARKER = "symphony-gate-card";
export const GATE_DECISION_MARKER = "symphony-gate";
const HOUR_MS = 3_600_000;

export interface PersonConfig {
  key: string;
  name: string;
  slackUserId: string | null;
  /** Linear email or display name (for assignment). */
  linearUser: string | null;
  maxOpenGates: number;
  maxNewGatesPerHour: number;
}

export interface GateHubConfig {
  operatorKey: string;
  people: PersonConfig[];
  /** Person key offered on design (visual) gates. */
  designPerson: string | null;
  /** Person key offered on product decisions. */
  productPerson: string | null;
  slackBotToken: string | null;
  persistPath: string;
  /** Local board URL, linked from cards (operator only). */
  boardUrl: string | null;
}

export type GateKindHandler = (resolution: GateResolution) => Promise<void>;
export type DraftHandler = (kind: "post" | "skip", draftId: string, by: string) => Promise<void>;

const KIND_ICON: Record<GateKind, string> = {
  approve_approach: "🧭", visual_signoff: "🎨", code_review: "🔍", pr_review: "👀", merge_deploy: "🚀",
  login_credential: "🔑", product_decision: "💡", triage_decision: "🗂️",
};

export function formatDecisionComment(resolution: GateResolution, byName: string | null): string {
  const { gate, decision } = resolution;
  const label = gate.actions.find(a => a.id === decision.actionId)?.label ?? decision.actionId;
  const icon = decision.actionKind === "approve" ? "✅" : decision.actionKind === "reject" ? "↩️" : "💬";
  const lines = [
    `<!-- ${GATE_DECISION_MARKER}:${gate.id}:${decision.actionId} -->`,
    `${icon} **${label}** — ${gate.title}${byName ? ` (${byName})` : ""}`,
  ];
  if (decision.note) lines.push("", decision.note);
  return lines.join("\n");
}

export function formatCardComment(gate: Gate, personName: string, forwardName: string | null): string {
  const approve = gate.actions.find(a => a.kind === "approve");
  const reject = gate.actions.find(a => a.kind === "reject");
  const lines = [
    AI_COMMENT_MARKER,
    `<!-- ${GATE_CARD_MARKER}:${gate.id} -->`,
    `${KIND_ICON[gate.kind]} **${gate.title}** — for ${personName}`,
    "",
    gate.summary,
  ];
  if (gate.question) lines.push("", `**${gate.question}**`);
  if (gate.links.length) lines.push("", gate.links.map(l => `[${l.label}](${l.url})`).join(" · "));
  for (const img of gate.images.filter(i => /^https?:\/\//.test(i.url)).slice(0, 4)) lines.push("", `![${img.label}](${img.url})`);
  const how: string[] = [];
  if (approve) how.push(`\`${approve.label.toLowerCase()}\``);
  if (reject) how.push(`\`${reject.label.toLowerCase()}: <what to change>\``);
  lines.push("", `_Reply ${how.join(" or ")} here, or tap the Slack card.${forwardName ? ` Reply \`ask ${forwardName.toLowerCase()}\` to hand it over.` : ""}_`);
  return lines.join("\n");
}

/** Interpret a human reply on the ticket. Returns an action id, "forward", or null. */
export function parseReply(gate: Gate, body: string): { actionId: string; note: string | null } | null {
  const text = body.trim();
  if (!text || text.includes(AI_COMMENT_MARKER)) return null;
  if (/^ask\s+\w+/i.test(text)) return { actionId: "forward", note: null };
  for (const action of gate.actions) {
    const label = action.label.toLowerCase().replace(/[^a-z0-9 +]/g, "").trim();
    const synonyms = action.kind === "approve"
      ? [label, "approve", "approved", "lgtm", "looks good", "ship it", "merge", "yes", "confirm"]
      : action.kind === "reject"
        ? [label, "send back", "request change", "request changes", "reject", "no", "redirect", "not a bug"]
        : [label];
    for (const s of synonyms) {
      const m = new RegExp(`^${s.replace(/[+]/g, "\\+")}\\b[:\\-–—\\s]*([\\s\\S]*)$`, "i").exec(text);
      if (m) return { actionId: action.id, note: m[1].trim() || null };
    }
  }
  return null;
}

export class GateHub {
  readonly store: GateStore;
  private readonly cfg: GateHubConfig;
  private readonly tracker: TrackerConfig;
  private readonly log: Logger;
  private readonly handlers = new Map<GateKind, GateKindHandler>();
  private readonly sideActions = new Map<string, (gate: Gate, by: string) => Promise<void>>();
  private draftHandler: DraftHandler | null = null;

  constructor(cfg: GateHubConfig, tracker: TrackerConfig, log: Logger) {
    this.cfg = cfg;
    this.tracker = tracker;
    this.log = log;
    this.store = new GateStore(cfg.persistPath, log, r => this.onResolved(r));
  }

  onKind(kind: GateKind, handler: GateKindHandler): void { this.handlers.set(kind, handler); }

  /**
   * A button that does something without deciding the card (e.g. 🧪 Functional
   * test). Clicking it, or replying with its label on the ticket, calls the
   * handler and leaves the card open.
   */
  onSideAction(actionId: string, handler: (gate: Gate, by: string) => Promise<void>): void {
    this.sideActions.set(actionId, handler);
  }

  private async runSideAction(gate: Gate, actionId: string, by: string): Promise<void> {
    const handler = this.sideActions.get(actionId);
    if (!handler) return;
    try {
      await handler(gate, by);
    } catch (e) {
      this.log.warn("Side action failed", { gate_id: gate.id, action: actionId, error: errMsg(e) });
    }
  }
  onDraft(handler: DraftHandler): void { this.draftHandler = handler; }

  person(key: string | null | undefined): PersonConfig | null {
    return this.cfg.people.find(p => p.key === (key ?? this.cfg.operatorKey)) ?? null;
  }

  personBySlack(userId: string): PersonConfig | null {
    return this.cfg.people.find(p => p.slackUserId === userId) ?? null;
  }

  load(key: string): { open: number; openedLastHour: number } {
    return {
      open: this.store.openByAssignee(key, this.cfg.operatorKey).length,
      openedLastHour: this.store.openedSinceFor(key, this.cfg.operatorKey, HOUR_MS),
    };
  }

  /** Default forward target for a kind (design → designer, product → product owner). */
  forwardFor(kind: GateKind): string | null {
    if (kind === "visual_signoff") return this.cfg.designPerson;
    if (kind === "product_decision") return this.cfg.productPerson;
    return null;
  }

  /** Open a card unless one of the same kind is already open for the issue. */
  async open(input: GateInput): Promise<Gate> {
    if (input.issueId) {
      const existing = this.store.openFor(input.issueId, input.kind)[0];
      if (existing) return existing;
    }
    const gate = this.store.open({
      ...input,
      assignee: input.assignee ?? this.cfg.operatorKey,
      forwardTo: input.forwardTo !== undefined ? input.forwardTo : this.forwardFor(input.kind),
    });
    await this.notify(gate);
    return gate;
  }

  private async notify(gate: Gate): Promise<void> {
    const person = this.person(gate.assignee);
    const forward = gate.forwardTo ? this.person(gate.forwardTo) : null;
    const name = person?.name ?? gate.assignee ?? "you";

    if (this.cfg.slackBotToken && person?.slackUserId) {
      try {
        const dm = await openDm(this.cfg.slackBotToken, person.slackUserId);
        const card = buildGateBlocks(gate, { forwardToName: forward?.name ?? null });
        const posted = await postMessage(this.cfg.slackBotToken, dm, card.text, card.blocks);
        this.store.update(gate.id, { slackRef: posted });
      } catch (e) {
        this.log.warn("Gate Slack card failed", { gate_id: gate.id, error: errMsg(e) });
      }
    }

    if (!gate.issueId) return;
    try {
      await linear.addComment(this.tracker, gate.issueId, formatCardComment(gate, name, forward?.name ?? null));
      await addIssueLabel(this.tracker, gate.issueId, `waiting-on:${gate.assignee ?? this.cfg.operatorKey}`);
      if (gate.assignee && gate.assignee !== this.cfg.operatorKey && person?.linearUser) {
        const userId = await resolveUserId(this.tracker, person.linearUser);
        const ctx = await getIssueContext(this.tracker, gate.issueId);
        if (userId && ctx && ctx.assigneeId !== userId) {
          this.store.update(gate.id, { meta: { previousAssigneeId: ctx.assigneeId ?? "" } });
          await setIssueAssignee(this.tracker, gate.issueId, userId);
        }
      }
    } catch (e) {
      this.log.warn("Gate Linear card failed", { gate_id: gate.id, issue: gate.issueIdentifier, error: errMsg(e) });
    }
  }

  /** Slack button handler (wired to SlackSocket). */
  async handleSlackAction(a: SlackAction): Promise<void> {
    const by = this.personBySlack(a.userId)?.name ?? a.userName ?? a.userId;
    const draft = parseDraftAction(a.actionId, a.value);
    if (draft) {
      if (this.draftHandler) await this.draftHandler(draft.kind, draft.draftId, by);
      return;
    }
    const parsed = parseGateActionValue(a.value);
    if (!parsed) return;
    if (parsed.actionId === "forward") {
      await this.forward(parsed.gateId, by);
      return;
    }
    if (this.sideActions.has(parsed.actionId)) {
      const gate = this.store.get(parsed.gateId);
      if (gate && gate.status === "open") await this.runSideAction(gate, parsed.actionId, by);
      return;
    }
    await this.store.resolve(parsed.gateId, parsed.actionId, null, by);
  }

  async forward(gateId: string, by: string): Promise<void> {
    const before = this.store.get(gateId);
    const oldRef = before?.slackRef ?? null;
    const oldAssignee = before?.assignee ?? this.cfg.operatorKey;
    const gate = this.store.forward(gateId);
    if (!gate) return;
    const to = this.person(gate.assignee);
    if (oldRef && this.cfg.slackBotToken) {
      await updateMessage(this.cfg.slackBotToken, oldRef.channel, oldRef.ts, `Sent to ${to?.name}`, [
        { type: "section", text: { type: "mrkdwn", text: `➡️ *${gate.title}* — sent to ${to?.name} by ${by}` } },
      ]).catch((e: unknown) => this.log.warn("Slack update failed", { error: errMsg(e) }));
    }
    const issueId = gate.issueId;
    if (issueId) {
      await quiet(() => removeIssueLabel(this.tracker, issueId, `waiting-on:${oldAssignee}`));
    }
    await this.notify(gate);
  }

  private async onResolved(r: GateResolution): Promise<void> {
    const { gate } = r;
    const by = r.decision.by ?? null;
    if (gate.slackRef && this.cfg.slackBotToken) {
      const done = buildResolvedBlocks(gate, by ?? "someone");
      const ref = gate.slackRef;
      const token = this.cfg.slackBotToken;
      await quiet(() => updateMessage(token, ref.channel, ref.ts, done.text, done.blocks));
    }
    if (gate.issueId) {
      try {
        await linear.addComment(this.tracker, gate.issueId, formatDecisionComment(r, by));
        await removeIssueLabel(this.tracker, gate.issueId, `waiting-on:${gate.assignee ?? this.cfg.operatorKey}`);
        const prev = gate.meta?.previousAssigneeId;
        if (prev !== undefined) await setIssueAssignee(this.tracker, gate.issueId, prev || null);
      } catch (e) {
        this.log.warn("Gate decision write-back failed", { gate_id: gate.id, error: errMsg(e) });
      }
    }
    const handler = this.handlers.get(gate.kind);
    if (handler) await handler(r);
  }

  /** Dismiss one open card (e.g. its PR was merged or closed elsewhere). */
  async dismissGate(gateId: string, why: string): Promise<void> {
    const g = this.store.get(gateId);
    if (!g || g.status !== "open") return;
    this.store.dismiss(g.id);
    const ref = g.slackRef;
    const token = this.cfg.slackBotToken;
    if (ref && token) {
      await quiet(() => updateMessage(token, ref.channel, ref.ts, `${g.title}: ${why}`, [
        { type: "context", elements: [{ type: "mrkdwn", text: `~${g.title}~ — ${why}` }] },
      ]));
    }
  }

  /** Plain DM to a person (defaults to the operator). Best effort. */
  async dm(text: string, personKey?: string): Promise<void> {
    const person = this.person(personKey ?? this.cfg.operatorKey);
    const token = this.cfg.slackBotToken;
    if (!token || !person?.slackUserId) return;
    await quiet(async () => postMessage(token, await openDm(token, person.slackUserId as string), text));
  }

  /** Dismiss open cards for an issue (it moved on without a decision). */
  async dismissFor(issueId: string, kind?: GateKind): Promise<void> {
    for (const g of this.store.openFor(issueId, kind)) {
      this.store.dismiss(g.id);
      const ref = g.slackRef;
      const token = this.cfg.slackBotToken;
      if (ref && token) {
        await quiet(() => updateMessage(token, ref.channel, ref.ts, `No longer needed: ${g.title}`, [
          { type: "context", elements: [{ type: "mrkdwn", text: `~${g.title}~ — no longer needed` }] },
        ]));
      }
      await quiet(() => removeIssueLabel(this.tracker, issueId, `waiting-on:${g.assignee ?? this.cfg.operatorKey}`));
    }
  }

  /** Resolve cards from human replies on the Linear ticket. Call every tick. */
  async reconcileLinearReplies(): Promise<void> {
    for (const gate of this.store.openGates()) {
      if (!gate.issueId) continue;
      let comments: linear.LinearComment[];
      try {
        comments = await linear.fetchIssueCommentsDetail(this.tracker, gate.issueId);
      } catch {
        continue;
      }
      // Side actions leave the card open, so remember the last reply that ran one.
      const since = Math.max(Date.parse(gate.createdAt), Date.parse(gate.meta?.sideActionReplyAt ?? "") || 0);
      for (const c of comments) {
        if (c.createdAt.getTime() <= since) continue;
        if (c.body.includes(GATE_DECISION_MARKER) || c.body.includes(GATE_CARD_MARKER)) continue;
        const parsed = parseReply(gate, c.body);
        if (!parsed) continue;
        const by = c.author?.name ?? "Linear";
        if (this.sideActions.has(parsed.actionId)) {
          this.store.update(gate.id, { meta: { ...(gate.meta ?? {}), sideActionReplyAt: c.createdAt.toISOString() } });
          await this.runSideAction(gate, parsed.actionId, `${by} (Linear)`);
        } else if (parsed.actionId === "forward") {
          if (gate.forwardTo) await this.forward(gate.id, by);
        } else {
          await this.store.resolve(gate.id, parsed.actionId, parsed.note, `${by} (Linear)`);
        }
        break;
      }
    }
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Best-effort side effect: never throws. */
async function quiet(fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch {
    // ignore
  }
}
