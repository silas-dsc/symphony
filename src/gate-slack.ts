/**
 * Slack Block Kit layouts for gate cards and channel-post drafts.
 * Button clicks come back over Socket Mode (see slack-socket.ts) with the
 * action_id / value encoded here; parse them with the helpers below.
 */

import type { Gate, GateActionKind, GateKind } from "./types.js";

export const GATE_ACTION_PREFIX = "symphony_gate";
export const DRAFT_ACTION_PREFIX = "symphony_draft";

const KIND_EMOJI: Record<GateKind, string> = {
  approve_approach: "🧭",
  visual_signoff: "🎨",
  code_review: "🔍",
  merge_deploy: "🚀",
  login_credential: "🔑",
  product_decision: "🤔",
  triage_decision: "🏷️",
};

const RESOLVED_EMOJI: Record<GateActionKind, string> = {
  approve: "✅",
  reject: "↩️",
  neutral: "💬",
};

// Slack Block Kit limits.
const HEADER_MAX = 150;
const SECTION_MAX = 3000;
const BUTTON_TEXT_MAX = 75;
const MAX_IMAGES = 2;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Escape the three characters Slack mrkdwn treats as control characters. */
function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function plain(text: string, max: number): { type: "plain_text"; text: string; emoji: true } {
  return { type: "plain_text", text: clip(text, max), emoji: true };
}

function mrkdwnSection(text: string): unknown {
  return { type: "section", text: { type: "mrkdwn", text: clip(text, SECTION_MAX) } };
}

function context(text: string): unknown {
  return { type: "context", elements: [{ type: "mrkdwn", text: clip(text, SECTION_MAX) }] };
}

function isAbsoluteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function headerBlock(gate: Gate): unknown {
  return { type: "header", text: plain(`${KIND_EMOJI[gate.kind] ?? "📌"} ${gate.title}`, HEADER_MAX) };
}

function bodyBlocks(gate: Gate, includeQuestion: boolean): unknown[] {
  const blocks: unknown[] = [];
  const parts: string[] = [];
  if (gate.summary.trim()) parts.push(esc(gate.summary.trim()));
  if (includeQuestion && gate.question?.trim()) parts.push(`*${esc(gate.question.trim())}*`);
  if (parts.length) blocks.push(mrkdwnSection(parts.join("\n\n")));
  return blocks;
}

function fallbackText(gate: Gate): string {
  const q = gate.question?.trim();
  return `${KIND_EMOJI[gate.kind] ?? "📌"} ${gate.title}${q ? ` — ${q}` : ""}`;
}

function metaLine(gate: Gate): string {
  const bits: string[] = [];
  if (gate.issueIdentifier) bits.push(esc(gate.issueIdentifier));
  bits.push(`~${gate.estimateMinutes} min`);
  if (gate.assignee) bits.push(esc(gate.assignee));
  return bits.join(" · ");
}

export function buildGateBlocks(
  gate: Gate,
  opts: { forwardToName?: string | null } = {},
): { text: string; blocks: unknown[] } {
  const blocks: unknown[] = [headerBlock(gate), ...bodyBlocks(gate, true)];

  const links = gate.links.filter((l) => l.url);
  if (links.length) {
    const line = links.map((l) => `<${l.url}|${esc(l.label).replace(/\|/g, "/")}>`).join("  ·  ");
    blocks.push(mrkdwnSection(line));
  }

  // Slack can only show images it can fetch, so board-relative paths are skipped.
  for (const img of gate.images.filter((i) => isAbsoluteUrl(i.url)).slice(0, MAX_IMAGES)) {
    blocks.push({
      type: "image",
      image_url: img.url,
      alt_text: clip(img.label || "screenshot", 2000),
      ...(img.label ? { title: plain(img.label, 2000) } : {}),
    });
  }

  const buttons: unknown[] = gate.actions.map((a) => ({
    type: "button",
    text: plain(a.label, BUTTON_TEXT_MAX),
    action_id: `${GATE_ACTION_PREFIX}:${a.id}`,
    value: `${gate.id}:${a.id}`,
    ...(a.kind === "approve" ? { style: "primary" } : a.kind === "reject" ? { style: "danger" } : {}),
  }));
  if (opts.forwardToName) {
    buttons.push({
      type: "button",
      text: plain(`Ask ${opts.forwardToName}`, BUTTON_TEXT_MAX),
      action_id: `${GATE_ACTION_PREFIX}:forward`,
      value: `${gate.id}:forward`,
    });
  }
  if (buttons.length) blocks.push({ type: "actions", block_id: `gate:${gate.id}`, elements: buttons.slice(0, 25) });

  blocks.push(context(metaLine(gate)));
  return { text: fallbackText(gate), blocks };
}

function hhmm(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The card after someone clicked: header + summary stay, buttons become a one-line outcome. */
export function buildResolvedBlocks(gate: Gate, byName: string): { text: string; blocks: unknown[] } {
  const decision = gate.decision;
  const action = decision ? gate.actions.find((a) => a.id === decision.actionId) : undefined;
  const kind: GateActionKind = decision?.actionKind ?? action?.kind ?? "neutral";
  const label = action?.label ?? decision?.actionId ?? (gate.status === "dismissed" ? "Dismissed" : "Done");
  const time = hhmm(decision?.at ?? gate.resolvedAt);

  let outcome = `${RESOLVED_EMOJI[kind]} ${esc(label)} — by ${esc(byName)}`;
  if (time) outcome += ` · ${time}`;
  if (decision?.note?.trim()) outcome += `\n> ${esc(decision.note.trim())}`;

  return {
    text: `${RESOLVED_EMOJI[kind]} ${gate.title} — ${label} by ${byName}`,
    blocks: [headerBlock(gate), ...bodyBlocks(gate, false), context(outcome)],
  };
}

/** Splits a button value "<gateId>:<actionId>". Gate ids may contain ':', action ids may not. */
export function parseGateActionValue(value: string): { gateId: string; actionId: string } | null {
  const i = value.lastIndexOf(":");
  if (i <= 0 || i === value.length - 1) return null;
  return { gateId: value.slice(0, i), actionId: value.slice(i + 1) };
}

/** A draft channel post for the operator to approve before it goes out. */
export function buildDraftBlocks(text: string, draftId: string): { text: string; blocks: unknown[] } {
  return {
    text: `Draft post: ${clip(text, 200)}`,
    blocks: [
      context("Draft for #dsc-website — post it?"),
      mrkdwnSection(text),
      {
        type: "actions",
        block_id: `draft:${draftId}`,
        elements: [
          {
            type: "button",
            text: plain("Post to #dsc-website", BUTTON_TEXT_MAX),
            action_id: `${DRAFT_ACTION_PREFIX}:post`,
            value: draftId,
            style: "primary",
          },
          {
            type: "button",
            text: plain("Skip", BUTTON_TEXT_MAX),
            action_id: `${DRAFT_ACTION_PREFIX}:skip`,
            value: draftId,
          },
        ],
      },
    ],
  };
}

export function parseDraftAction(actionId: string, value: string): { kind: "post" | "skip"; draftId: string } | null {
  if (!value) return null;
  if (actionId === `${DRAFT_ACTION_PREFIX}:post`) return { kind: "post", draftId: value };
  if (actionId === `${DRAFT_ACTION_PREFIX}:skip`) return { kind: "skip", draftId: value };
  return null;
}
