import { describe, expect, it } from "vitest";
import {
  GATE_ACTION_PREFIX,
  buildDraftBlocks,
  buildGateBlocks,
  buildResolvedBlocks,
  parseDraftAction,
  parseGateActionValue,
} from "../gate-slack.js";
import type { Gate } from "../types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBlock = any;

function gate(overrides: Partial<Gate> = {}): Gate {
  return {
    id: "g1",
    kind: "visual_signoff",
    createdAt: "2026-11-04T10:00:00.000Z",
    resolvedAt: null,
    status: "open",
    issueId: null,
    issueIdentifier: "TEA-1",
    title: "Check the new header",
    summary: "Header now matches Figma. Checked: desktop. Not checked: mobile.",
    question: "Does this look right?",
    links: [
      { label: "Preview", url: "https://preview.example.com" },
      { label: "Design", url: "https://figma.com/x" },
    ],
    images: [
      { label: "Live", url: "https://img.example.com/1.png" },
      { label: "Relative", url: "/gate-assets/g1/2.png" },
      { label: "Design", url: "https://img.example.com/2.png" },
      { label: "Third", url: "https://img.example.com/3.png" },
    ],
    actions: [
      { id: "approve", label: "Looks good", kind: "approve", primary: true },
      { id: "request_change", label: "Request change", kind: "reject" },
      { id: "later", label: "Later", kind: "neutral" },
    ],
    decision: null,
    estimateMinutes: 3,
    assignee: "Nika",
    ...overrides,
  };
}

describe("buildGateBlocks", () => {
  it("lays out header, body, links, images, buttons and context", () => {
    const { text, blocks } = buildGateBlocks(gate());
    expect(text).toContain("Check the new header");
    const b = blocks as AnyBlock[];
    expect(b[0].type).toBe("header");
    expect(b[0].text.text).toBe("🎨 Check the new header");
    expect(b[1].text.text).toContain("Header now matches Figma");
    expect(b[1].text.text).toContain("*Does this look right?*");
    expect(b[2].text.text).toBe("<https://preview.example.com|Preview>  ·  <https://figma.com/x|Design>");

    const images = b.filter((x) => x.type === "image");
    expect(images.map((i) => i.image_url)).toEqual(["https://img.example.com/1.png", "https://img.example.com/2.png"]);

    const actions = b.find((x) => x.type === "actions");
    expect(actions.elements).toHaveLength(3);
    expect(actions.elements[0]).toMatchObject({
      action_id: `${GATE_ACTION_PREFIX}:approve`,
      value: "g1:approve",
      style: "primary",
    });
    expect(actions.elements[1]).toMatchObject({ value: "g1:request_change", style: "danger" });
    expect(actions.elements[2].style).toBeUndefined();

    const ctx = b[b.length - 1];
    expect(ctx.type).toBe("context");
    expect(ctx.elements[0].text).toBe("TEA-1 · ~3 min · Nika");
  });

  it("adds an Ask <name> forward button", () => {
    const { blocks } = buildGateBlocks(gate(), { forwardToName: "Silas" });
    const actions = (blocks as AnyBlock[]).find((x) => x.type === "actions");
    const last = actions.elements[actions.elements.length - 1];
    expect(last).toMatchObject({ action_id: "symphony_gate:forward", value: "g1:forward" });
    expect(last.text.text).toBe("Ask Silas");
  });

  it("escapes mrkdwn control characters and omits empty parts", () => {
    const { blocks } = buildGateBlocks(
      gate({ summary: "a < b & c", question: null, links: [], images: [], assignee: null, issueIdentifier: null }),
    );
    const b = blocks as AnyBlock[];
    expect(b[1].text.text).toBe("a &lt; b &amp; c");
    expect(b.filter((x) => x.type === "image")).toHaveLength(0);
    expect(b[b.length - 1].elements[0].text).toBe("~3 min");
  });
});

describe("buildResolvedBlocks", () => {
  it("replaces buttons with an outcome line", () => {
    const at = "2026-11-04T14:32:00.000Z";
    const d = new Date(at);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const g = gate({
      status: "resolved",
      resolvedAt: at,
      decision: { actionId: "approve", actionKind: "approve", note: null, at },
    });
    const { blocks } = buildResolvedBlocks(g, "Silas");
    const b = blocks as AnyBlock[];
    expect(b[0].type).toBe("header");
    expect(b[1].text.text).toContain("Header now matches Figma");
    expect(b.some((x) => x.type === "actions")).toBe(false);
    expect(b[b.length - 1].elements[0].text).toBe(`✅ Looks good — by Silas · ${hhmm}`);
  });

  it("uses ↩️ for reject and 💬 for neutral", () => {
    const at = "2026-11-04T14:32:00.000Z";
    const rej = buildResolvedBlocks(
      gate({ decision: { actionId: "request_change", actionKind: "reject", note: "Fix spacing", at } }),
      "Nika",
    ).blocks as AnyBlock[];
    expect(rej[rej.length - 1].elements[0].text).toMatch(/^↩️ Request change — by Nika · \d\d:\d\d\n> Fix spacing$/);
    const neu = buildResolvedBlocks(gate({ decision: { actionId: "later", actionKind: "neutral", note: null, at } }), "Evie")
      .blocks as AnyBlock[];
    expect(neu[neu.length - 1].elements[0].text).toMatch(/^💬 Later — by Evie/);
  });
});

describe("parsers", () => {
  it("parseGateActionValue", () => {
    expect(parseGateActionValue("g1:approve")).toEqual({ gateId: "g1", actionId: "approve" });
    expect(parseGateActionValue("gate:abc:merge")).toEqual({ gateId: "gate:abc", actionId: "merge" });
    expect(parseGateActionValue("nope")).toBeNull();
    expect(parseGateActionValue(":x")).toBeNull();
    expect(parseGateActionValue("g1:")).toBeNull();
  });

  it("draft blocks + parseDraftAction", () => {
    const { blocks } = buildDraftBlocks("Shipped the new header", "d1");
    const actions = (blocks as AnyBlock[]).find((x) => x.type === "actions");
    expect(actions.elements.map((e: AnyBlock) => [e.action_id, e.value, e.text.text])).toEqual([
      ["symphony_draft:post", "d1", "Post to #dsc-website"],
      ["symphony_draft:skip", "d1", "Skip"],
    ]);
    expect(parseDraftAction("symphony_draft:post", "d1")).toEqual({ kind: "post", draftId: "d1" });
    expect(parseDraftAction("symphony_draft:skip", "d1")).toEqual({ kind: "skip", draftId: "d1" });
    expect(parseDraftAction("symphony_gate:approve", "d1")).toBeNull();
    expect(parseDraftAction("symphony_draft:post", "")).toBeNull();
  });
});
