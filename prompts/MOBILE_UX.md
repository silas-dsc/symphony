# Mobile UX/UI pass (every affected frontend page)

Apply this to every page or component you modified, and every page that consumes a component you modified. Mobile is the default — verify at 375px first, then desktop.

**This prompt covers checks you apply as you code.** The full screenshot evidence is captured by the Tester sub-agent in Phase 4 (see `TESTER.md`). Your job here is to make sure the page is right when the Tester arrives — not to capture deliverable screenshots yourself.

The agent has headless Chrome via the `@playwright/mcp` server, launched with `--ignore-https-errors`. If the tools aren't available, the MCP server failed to start — investigate before declaring a blocker.

## Mandatory checks (every affected page)

### Layout & scrollability
- [ ] All content reachable by scrolling on a **375px-wide viewport** (iPhone SE width).
- [ ] No horizontal page scroll. Wide tables scroll *inside their container*, not the page.
- [ ] Sticky headers/footers don't cover the bottom of forms or content. Verify with the on-screen keyboard open if the page has inputs.
- [ ] Modals, drawers, and sheets are full-height on mobile and dismissible by a visible close control (not just by tapping outside).

### Touch targets & interaction
- [ ] Interactive elements are at least **44×44 px**. Tailwind: `min-h-[44px] min-w-[44px]` or padded `p-3`+.
- [ ] Buttons have a visible pressed/active state, not just `:hover` (hover doesn't exist on touch).
- [ ] Links and buttons are distinguishable from body text without relying on colour alone (underline, border, icon, or weight).

### Feedback states
- [ ] **Loading:** every async UI shows a spinner, skeleton, or progress indicator within 200ms.
- [ ] **Form submission:** submit button disables on submit, shows "Saving…" or a spinner, surfaces success/error toast or banner on completion.
- [ ] **Empty:** lists and tables render an explicit empty-state message (not a blank box).
- [ ] **Error:** failed loads render an error message with a retry affordance — not silent failure or infinite spinner.

### Forms
- [ ] Forms longer than ~6 fields are grouped under headings or **collapsible sections**.
- [ ] Multi-step forms have a visible progress indicator (step N of M).
- [ ] Validation errors appear **next to the field that failed**, not only at the top.
- [ ] Labels are above inputs on mobile (not beside).
- [ ] Submit button is reachable without long-scrolling — sticky footer for long forms.
- [ ] `inputMode` and `autocomplete` are set on inputs where appropriate (`email`, `tel`, `numeric`, `one-time-code`).

### Accessibility quick-pass
- [ ] All form fields have a `<label>` or `aria-label`.
- [ ] All icon-only buttons have `aria-label`.
- [ ] Page has a single `<h1>`; heading levels are sequential.
- [ ] Body text contrast ≥ 4.5:1.

## Lightweight self-verify (no deliverable screenshots)

The dev server is already running on the HTTPS proxy port:

```bash
PROXY_PORT=$(grep PROXY_PORT .symphony-ports | cut -d= -f2)
```

Walk each modified page through `browser_resize` (375×667) → `browser_navigate` → `browser_snapshot` → `browser_console_messages`. Fix anything wrong. Do **not** save screenshots here — the Tester captures them.

If you do screenshot for your own diagnostic use (debugging a layout issue), capture only the element you're investigating. Pass `element` + `ref` from `browser_snapshot` to `browser_take_screenshot`. Whole-page screenshots are not used anywhere in this workflow.

### If the page won't load
1. Wait 10s and reload. Retry up to 5 times.
2. Restart the dev server (see `WORKFLOW.md` → "What is and is not a blocker").
3. Scan for live ports if `.symphony-ports` is stale: `lsof -iTCP -sTCP:LISTEN -nP | grep -E ':(3|5)[0-9]{3}\s'`.
4. Check credentials per `{{ symphony.root }}/docs/TEAM_DSC_LOGIN.md`.
5. Examine `/tmp/symphony-app-*.log` for compile errors; fix and restart.

## When you find UX issues outside ticket scope

File a Linear Backlog ticket and link it from the workpad. Fix only what is directly produced or worsened by your change.

## Record in workpad

```
Mobile UX self-check on <commit SHA>:
- Pages verified at 375px and 1024px: <list>
- Issues found and fixed in this PR: <list or "none">
- Backlog tickets filed for out-of-scope UX issues: <links or "none">
```

Deliverable screenshots are produced and attached by the Tester in Phase 4.
