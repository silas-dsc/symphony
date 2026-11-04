import * as fs from "node:fs";
import * as crypto from "node:crypto";
import type {
  Gate,
  GateAction,
  GateDecision,
  GateInput,
  GateKind,
  GateStatus,
  Logger,
} from "./types.js";

/**
 * Default one-click button sets per gate kind. A producer can override by passing
 * its own `actions`, but these keep every card to the minimum the human needs:
 * one obvious primary action plus (usually) one redirect.
 */
export function defaultActionsFor(kind: GateKind): GateAction[] {
  switch (kind) {
    case "approve_approach":
      return [
        { id: "approve", label: "Approve", kind: "approve", primary: true },
        { id: "redirect", label: "Redirect", kind: "reject" },
      ];
    case "visual_signoff":
      return [
        { id: "looks_good", label: "Looks good", kind: "approve", primary: true },
        { id: "request_change", label: "Request change", kind: "reject" },
      ];
    case "code_review":
      return [
        { id: "merge", label: "Merge", kind: "approve", primary: true },
        { id: "send_back", label: "Send back", kind: "reject" },
      ];
    case "merge_deploy":
      return [{ id: "deploy", label: "Merge + deploy", kind: "approve", primary: true }];
    case "login_credential":
      return [{ id: "done", label: "Done", kind: "approve", primary: true }];
    case "product_decision":
      return [
        { id: "decide", label: "Decide", kind: "approve", primary: true },
        { id: "ask", label: "Ask", kind: "neutral" },
      ];
    case "triage_decision":
      return [
        { id: "confirm", label: "Confirm", kind: "approve", primary: true },
        { id: "not_a_bug", label: "Not a bug", kind: "reject" },
      ];
  }
}

/** Default review-time estimate (minutes) per gate kind, used by the capacity governor. */
function defaultEstimateFor(kind: GateKind): number {
  switch (kind) {
    case "merge_deploy":
    case "login_credential":
      return 2;
    case "approve_approach":
    case "triage_decision":
      return 3;
    case "code_review":
      return 5;
    case "visual_signoff":
      return 4;
    case "product_decision":
      return 8;
  }
}

export interface GateResolution {
  gate: Gate;
  decision: GateDecision;
}

export type GateResolveHandler = (resolution: GateResolution) => void | Promise<void>;

/**
 * The human gate queue. In-memory map backed by a JSON file so open gates survive
 * a Symphony restart (mirrors the orchestrator's slack-queue persistence). Pure
 * except for the file I/O and the injected resolve handler, so it is easy to test.
 */
export class GateStore {
  private readonly gates = new Map<string, Gate>();
  private readonly persistPath: string;
  private readonly log: Logger;
  private onResolve: GateResolveHandler | null;

  constructor(persistPath: string, log: Logger, onResolve: GateResolveHandler | null = null) {
    this.persistPath = persistPath;
    this.log = log;
    this.onResolve = onResolve;
    this.load();
  }

  setResolveHandler(handler: GateResolveHandler): void {
    this.onResolve = handler;
  }

  /** Open a new gate. Returns the stored gate (with id + bookkeeping filled in). */
  open(input: GateInput): Gate {
    const now = new Date().toISOString();
    const gate: Gate = {
      id: crypto.randomUUID(),
      kind: input.kind,
      createdAt: now,
      resolvedAt: null,
      status: "open",
      issueId: input.issueId ?? null,
      issueIdentifier: input.issueIdentifier ?? null,
      title: input.title,
      summary: input.summary,
      question: input.question ?? null,
      links: input.links ?? [],
      images: input.images ?? [],
      actions: input.actions ?? defaultActionsFor(input.kind),
      decision: null,
      estimateMinutes: input.estimateMinutes ?? defaultEstimateFor(input.kind),
      assignee: input.assignee ?? null,
      forwardTo: input.forwardTo ?? null,
      meta: input.meta ?? {},
      slackRef: null,
    };
    this.gates.set(gate.id, gate);
    this.persist();
    this.log.info("Gate opened", {
      gate_id: gate.id,
      kind: gate.kind,
      issue: gate.issueIdentifier ?? "n/a",
    });
    return gate;
  }

  get(id: string): Gate | undefined {
    return this.gates.get(id);
  }

  list(status?: GateStatus): Gate[] {
    const all = [...this.gates.values()];
    const filtered = status ? all.filter(g => g.status === status) : all;
    // Newest first.
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  openGates(): Gate[] {
    return this.list("open");
  }

  /** Count of gates opened in the last `windowMs` (used for the per-hour rate cap). */
  openedSince(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    let n = 0;
    for (const g of this.gates.values()) {
      if (Date.parse(g.createdAt) >= cutoff) n++;
    }
    return n;
  }

  /**
   * Resolve a gate by applying one of its actions. Returns the updated gate, or
   * null if the gate is unknown, already resolved, or the action id is invalid.
   * The injected resolve handler (Linear/GitHub side-effects) is fired after the
   * decision is persisted, so a handler failure never loses the recorded decision.
   */
  /** Open gates for one issue (optionally one kind). */
  openFor(issueId: string, kind?: GateKind): Gate[] {
    return this.openGates().filter(g => g.issueId === issueId && (!kind || g.kind === kind));
  }

  /** Open gates assigned to a person key. Unassigned gates count as the operator's. */
  openByAssignee(key: string, operatorKey: string): Gate[] {
    return this.openGates().filter(g => (g.assignee ?? operatorKey) === key);
  }

  /** Gates opened for a person in the last `windowMs`. */
  openedSinceFor(key: string, operatorKey: string, windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    return [...this.gates.values()].filter(
      g => (g.assignee ?? operatorKey) === key && Date.parse(g.createdAt) >= cutoff,
    ).length;
  }

  /** Patch bookkeeping fields (Slack ref, meta). */
  update(id: string, patch: Partial<Pick<Gate, "slackRef" | "meta">>): Gate | null {
    const gate = this.gates.get(id);
    if (!gate) return null;
    if (patch.slackRef !== undefined) gate.slackRef = patch.slackRef;
    if (patch.meta) gate.meta = { ...(gate.meta ?? {}), ...patch.meta };
    this.persist();
    return gate;
  }

  /** Hand an open gate to its `forwardTo` person. Returns null if not forwardable. */
  forward(id: string): Gate | null {
    const gate = this.gates.get(id);
    if (!gate || gate.status !== "open" || !gate.forwardTo) return null;
    gate.meta = { ...(gate.meta ?? {}), forwardedFrom: gate.assignee ?? "" };
    gate.assignee = gate.forwardTo;
    gate.forwardTo = null;
    gate.slackRef = null;
    this.persist();
    this.log.info("Gate forwarded", { gate_id: gate.id, to: gate.assignee });
    return gate;
  }

  async resolve(id: string, actionId: string, note: string | null = null, by: string | null = null): Promise<Gate | null> {
    const gate = this.gates.get(id);
    if (!gate) {
      this.log.warn("Resolve on unknown gate", { gate_id: id });
      return null;
    }
    if (gate.status !== "open") {
      this.log.warn("Resolve on already-closed gate", { gate_id: id, status: gate.status });
      return null;
    }
    const action = gate.actions.find(a => a.id === actionId);
    if (!action) {
      this.log.warn("Resolve with unknown action", { gate_id: id, action_id: actionId });
      return null;
    }

    const decision: GateDecision = {
      actionId: action.id,
      actionKind: action.kind,
      note: note?.trim() ? note.trim() : null,
      at: new Date().toISOString(),
      by,
    };
    gate.status = "resolved";
    gate.resolvedAt = decision.at;
    gate.decision = decision;
    this.persist();
    this.log.info("Gate resolved", {
      gate_id: gate.id,
      action: action.id,
      kind: gate.kind,
      issue: gate.issueIdentifier ?? "n/a",
    });

    if (this.onResolve) {
      try {
        await this.onResolve({ gate, decision });
      } catch (e) {
        this.log.error("Gate resolve handler failed", {
          gate_id: gate.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return gate;
  }

  /** Dismiss a gate without a human decision (e.g. the ticket moved on / became stale). */
  dismiss(id: string): Gate | null {
    const gate = this.gates.get(id);
    if (!gate || gate.status !== "open") return null;
    gate.status = "dismissed";
    gate.resolvedAt = new Date().toISOString();
    this.persist();
    this.log.info("Gate dismissed", { gate_id: gate.id, kind: gate.kind });
    return gate;
  }

  // ─── Persistence (best-effort; never throws into the caller) ────────────────

  private persist(): void {
    // Keep closed gates for 30 days (history for reports), then drop them.
    const cutoff = Date.now() - 30 * 86_400_000;
    for (const [id, g] of this.gates) {
      if (g.status !== "open" && g.resolvedAt && Date.parse(g.resolvedAt) < cutoff) this.gates.delete(id);
    }
    try {
      fs.writeFileSync(this.persistPath, JSON.stringify([...this.gates.values()], null, 2), "utf-8");
    } catch (e) {
      this.log.warn("Gate persist failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.persistPath, "utf-8");
    } catch {
      return; // No file yet — fresh queue.
    }
    try {
      const parsed = JSON.parse(raw) as Gate[];
      if (!Array.isArray(parsed)) return;
      for (const gate of parsed) {
        if (gate && typeof gate.id === "string") this.gates.set(gate.id, gate);
      }
      this.log.info("Gate queue restored", { count: this.gates.size });
    } catch (e) {
      this.log.warn("Gate queue restore failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }
}
