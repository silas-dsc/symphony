# Figma intake — design → requirements → spec

Triggered from Phase 1 when the ticket description contains a `figma.com/design/...` URL. Produces the Technical Approach and Test Plan sections that Phase 1 then merges into the refined description, plus per-screen specs that Phase 3 hands off to sub-agents.

## Why this exists

A single `get_design_context` call on a multi-screen Figma page returns enormous payloads. Past attempts loaded the whole design at once and the agent lost track. This workflow chunks the design into discrete artifacts, each phase reading only what it needs.

## Prerequisite (degrades gracefully without it)

Phase D produces better specs when team-dsc has [Figma Code Connect](https://www.figma.com/code-connect-docs/) configured — `get_design_context` then returns mapped React component snippets instead of unmapped raw code. Look for `figma.config.json` and `*.figma.tsx` files under `packages/app/`. If they're absent, intake still works; Phase D just guesses component names from token names and screenshots, which is less reliable.

## Setup

### 1. Parse the Figma URL

Extract `fileKey` and `nodeId` from the URL. Conversions:
- `figma.com/design/:fileKey/...?node-id=:nodeId` → convert `-` to `:` in the nodeId
- `figma.com/design/:fileKey/branch/:branchKey/...` → use `branchKey` as `fileKey`

### 2. Prepare the artifacts directory

```bash
mkdir -p .symphony-figma/screens
# Ensure local-only gitignore (does not modify team-dsc's tracked .gitignore)
grep -q '^.symphony-figma/$' .git/info/exclude 2>/dev/null \
  || echo '.symphony-figma/' >> .git/info/exclude
```

### 3. Confirm Figma MCP is available

The Figma MCP exposes `get_metadata`, `get_design_context`, `get_screenshot`, and Code Connect tools. If any of these calls fail, document the failure in `.claude/workpad.md` and treat it as a blocker — Figma intake cannot proceed without MCP access.

### Public-surface rule

**Every Figma intake artefact stays in `.symphony-figma/`.** Do not post anything to Linear or the PR — no `## Figma intake — *` comments, no file attachments, nothing. The Refiner (Phase 1B) folds `tech-spec.md` into the refined Linear description; that is the only thing intake produces that ever reaches Linear, and it goes into the description, not a comment.

---

## Phase A — Enumerate (cheap)

**Tool:** `get_metadata` on the parent page node (the nodeId from the URL).

**Output:** `.symphony-figma/manifest.json`

```json
{
  "fileKey": "mL6vgv3ex93dR8o6QdRjQv",
  "rootNodeId": "6801:33333",
  "fetchedAt": "2026-05-11T...",
  "frames": [
    { "id": "6801:33334", "name": "Assign Dialog - Step 1", "type": "FRAME",
      "width": 800, "height": 600, "x": 0, "y": 0 },
    ...
  ]
}
```

`get_metadata` returns a tree — flatten it so `frames` contains only the top-level frames on the page (not every node inside them). Save the raw response alongside as `manifest-raw.json` for debugging.

**Definition of Done:** `manifest.json` exists in `.symphony-figma/` with frame count > 0. Nothing posted to Linear.

---

## Phase B — Classify (LLM-only, no Figma calls)

Read `manifest.json`. Classify every frame using the heuristics below. **Do not call Figma MCP in this phase.**

**Classification heuristics:**

| Type | Cue |
|---|---|
| `Desktop` | width ≥ 1024px, contains layout structure |
| `Mobile` | width 320–500px |
| `Tablet` | width 500–1023px |
| `Modal` | name contains "modal" / "dialog" / "sheet" / "drawer" |
| `Element` | name starts with "Component", "Element", "Icon", "Button", "Card" — building blocks, not full screens |
| `Variant` | sibling frames with names like "X — empty", "X — loading", "X — error" |
| `Note` | name contains "note", "annotation", "todo", or frame is small (<200×200) and isolated |
| `Cover` | name contains "cover" / "title" / "intro" — non-functional |

**Output:** `.symphony-figma/classification.json`

```json
{
  "Desktop":   ["6801:33334", "6801:33335", ...],
  "Mobile":    ["6801:33340", ...],
  "Modal":     ["6801:33336"],
  "Element":   [...],
  "Variant":   { "6801:33335": ["6801:33337", "6801:33338"] },
  "Note":      [...],
  "Cover":     [...],
  "Unclassified": [...]
}
```

If a frame doesn't fit cleanly, put it in `Unclassified` and surface the ambiguity in `.claude/workpad.md` — don't force a category.

**Definition of Done:** every frame in the manifest appears in exactly one bucket of `classification.json` (variants nest under their parent). Nothing posted to Linear.

---

## Phase C — Flow inference (one screenshot + reasoning)

Goal: infer the directed graph of transitions between Desktop/Mobile/Modal frames. Reading order, click targets, tab switches.

### Steps

1. Call `get_screenshot` on the **parent page node** at low resolution. One image, cheap. This is your bird's-eye view of the canvas.
2. Read `manifest.json` (for frame positions) and `classification.json` (for which frames are screens vs noise).
3. Reason over the screenshot + positions + names to produce a flow graph:
   - **Reading order:** left-to-right, then top-to-bottom by `x` then `y` of each frame.
   - **Transitions:** look for visual matches between a CTA in one frame and the next frame's content. E.g. "clicking Next on Frame A → Frame B" because Frame B shows the next step of the same dialog.
   - **Tab switches:** if two frames differ only by which tab is active, they're variants of the same logical screen reached by clicking the tab.
   - **Modal triggers:** modal frames are reached by clicking a button on the underlying screen — identify which screen and which button by visual cues.

**Output:** `.symphony-figma/flow.json`

```json
{
  "entry": "6801:33334",
  "nodes": [
    { "id": "6801:33334", "label": "Assign Dialog — Step 1: Pick courses",   "viewport": "Desktop" },
    { "id": "6801:33335", "label": "Assign Dialog — Step 2: Learners tab",   "viewport": "Desktop" },
    { "id": "6801:33340", "label": "Assign Dialog — Step 2: Groups tab",     "viewport": "Desktop" },
    { "id": "6801:33336", "label": "Assign Dialog — Step 3: Due date",       "viewport": "Desktop" }
  ],
  "edges": [
    { "from": "6801:33334", "to": "6801:33335", "trigger": "click Next button",         "confidence": "high" },
    { "from": "6801:33335", "to": "6801:33340", "trigger": "click Groups tab",          "confidence": "high" },
    { "from": "6801:33340", "to": "6801:33335", "trigger": "click Learners tab",        "confidence": "high" },
    { "from": "6801:33335", "to": "6801:33336", "trigger": "click Next button",         "confidence": "high" },
    { "from": "6801:33340", "to": "6801:33336", "trigger": "click Next button",         "confidence": "high" }
  ],
  "assumptions": [
    "Treated 'Step 2 Learners' and 'Step 2 Groups' as variants of one logical step reached via tab switch.",
    "Inferred Next button order from x-position of frames on canvas (left to right)."
  ]
}
```

Record the assumptions list and a text-rendered diagram (ASCII or mermaid) of the graph in `.symphony-figma/flow.md` alongside `flow.json` — useful for the operator to spot-check by pulling the workspace. Do not post to Linear.

**Definition of Done:** every Desktop/Mobile/Modal screen from classification is a node in flow.json. Every node except `entry` has at least one incoming edge. Assumptions list is non-empty and specific. Nothing posted to Linear.

---

## Phase D — Per-screen deep dive (sequential, one frame at a time)

For each screen in `flow.json` (in topological order from `entry`), call `get_design_context` with that **single frame's nodeId**. Do not load more than one frame per call.

### What `get_design_context` returns

A mix of generated code, screenshots, and hints. **Treat the code as a reference, not the final implementation.** Look in particular for:

- **Code Connect snippets** — if a Figma component is mapped to a team-dsc React component (`packages/app/components/...`), use that mapped component name in your spec. Set up Code Connect for the codebase via `figma:figma-create-design-system-rules` if mappings are missing.
- **Component documentation links** — follow them for the component's API contract.
- **Design tokens as CSS variables** — map to team-dsc's existing Tailwind theme.
- **Annotations** — designer notes about behavior, copy, edge cases.

### Per-screen spec output

For each screen, write `.symphony-figma/screens/<nodeId-sanitized>.md`:

```md
# <Screen label from flow.json>

**Figma nodeId:** `<id>`
**Viewport:** Desktop / Mobile / Modal
**Reached from:** <list of (sourceFrame, trigger) tuples from flow.json>
**Leads to:** <list of (destinationFrame, trigger)>

## Layout
<one-paragraph description of the screen's structure: header, body, footer, sidebar, etc.>

## Components
| Region | Component | Source | Notes |
|---|---|---|---|
| Header  | `DialogHeader`        | `packages/app/components/ui/dialog.tsx` (Code Connect) | title + close button |
| Sidebar | `<new component>`     | needs to be built                                      | step list with active state |
| Body    | `Input`, `Checkbox`   | `packages/app/components/ui/input.tsx`                | search + result list |
| Footer  | `Button` (primary, secondary) | `packages/app/components/ui/button.tsx`        | Cancel / Next |

## States
- **Loading:** skeleton rows for the result list; disable Next button.
- **Empty:** "No courses match your search" message + clear-search link.
- **Error:** banner above the list with retry.
- **Default:** populated list, Next enabled when ≥1 selection.

## Interactions
- Typing in search input filters the list with 200ms debounce.
- Checkbox click toggles selection; selected count updates in the Next button's badge.
- Clicking Next advances to <destination>.
- Clicking Cancel closes the dialog without saving.

## Copy
| Element | Text |
|---|---|
| Title | "Assign Courses" |
| Search placeholder | "Search…" |
| Empty state | "No courses match your search." |
| Primary CTA | "Next" |

## Responsive
- Mobile (≤640px): sidebar collapses into a top bar; footer buttons full-width.
- Desktop: two-column layout per the design.

## Acceptance criteria
- [ ] Header renders correctly at all viewports.
- [ ] Search debounces at 200ms ± 50ms.
- [ ] Selection state persists when switching between sidebar steps.
- [ ] Clicking Next advances to <destination> only when ≥1 item is selected.
- [ ] Loading, empty, and error states all reachable in dev.
```

**Definition of Done:** every screen node in `flow.json` has a corresponding `.symphony-figma/screens/<id>.md` file. Every spec contains all six sections (Layout, Components, States, Interactions, Copy, Responsive, AC). Nothing posted to Linear.

---

## Phase E — Tech spec consolidation

Read all `screens/*.md` plus the relevant slice of the team-dsc codebase. Produce one `.symphony-figma/tech-spec.md` that describes the implementation as a whole.

### Required sections

```md
# Tech spec: <ticket title>

## Files
- New: <paths>
- Modified: <paths>
- Deleted: <paths>

## Routes
<which Remix routes are affected, new params/loaders/actions>

## Shared components
<components used by multiple screens — extract once, reuse>

## Data flow
<which Firestore collections are read/written, which Cloud Functions called, loader/action shape>

## State management
<URL state vs. component state vs. server state; where each lives>

## Migrations
<schema changes, data backfills, none>

## Out of scope
<what is explicitly NOT being built in this PR>

## Implementation order
1. Screen <id> — <label> (depends on nothing)
2. Screen <id> — <label> (depends on shared component from step 1)
...
```

The **Implementation order** drives Phase 3's sub-agent dispatch. List screens in dependency order: shared components first, then dependent screens. Sub-agents will be spawned in this order, one at a time.

**Definition of Done:** `.symphony-figma/tech-spec.md` exists with all sections populated. Implementation order is a complete topological sort of the screen dependencies. Nothing posted to Linear — the Refiner (Phase 1B) folds this file's Technical Approach / Test Plan / Out of Scope into the refined Linear description.

---

## Handoff to Phase 1 (refined ticket)

The refined Linear ticket description should now include:

- **Technical Approach** section: a condensed version of `tech-spec.md` (the Files, Routes, Shared components, Data flow sections).
- **Test Plan** section: aggregate the AC and Responsive checks from every `screens/*.md`.
- **Out of Scope** section: copy from `tech-spec.md`.

The Acceptance Criteria section in the refined description points to the per-screen ACs as the source of truth.

The artifacts (`manifest.json`, `classification.json`, `flow.json`, `screens/*.md`, `tech-spec.md`) all live in `.symphony-figma/` and persist across retries.

## Resume on retry

If `.symphony-figma/` already exists with some artifacts:
- Check which phase's output is present and skip to the first missing phase.
- Do not re-run earlier phases unless explicitly invalidated (e.g. Figma URL changed).
- Nothing was ever posted to Linear, so there's nothing to deduplicate.
