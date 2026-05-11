# Mobile UX/UI pass (every affected frontend page)

Apply this to every page or component you modified, and every page that consumes a component you modified. Mobile is the default — verify mobile first, then desktop.

The agent has headless Chrome via the `@playwright/mcp` server, wired up by Symphony at spawn time with `--ignore-https-errors` so the self-signed dev cert is accepted. The tool prefix is `mcp__playwright__`. If the tools aren't available, the MCP server failed to start — investigate (`npx @playwright/mcp@latest --help` runs? Chrome installed via Playwright?) before declaring a blocker.

## Mandatory checks (every affected page)

### Layout & scrollability
- [ ] All content reachable by scrolling on a **375px-wide viewport** (iPhone SE width).
- [ ] No horizontal page scroll on mobile. (If the content is a wide table, it scrolls *within* its own container, not the page.)
- [ ] Sticky headers/footers don't cover the bottom of forms or content. Verify with the on-screen keyboard open if the page has inputs.
- [ ] Modals, drawers, and sheets are full-height on mobile and dismissible by a visible close control (not just by tapping outside).

### Touch targets & interaction
- [ ] Interactive elements are at least **44×44 px** tap target. Tailwind: `min-h-[44px] min-w-[44px]`, or padded `p-3`+ with readable text.
- [ ] Buttons have a visible pressed/active state, not just `:hover` (hover doesn't exist on touch).
- [ ] Links and buttons are distinguishable from body text without relying on colour alone (underline, border, icon, or weight).

### Feedback states
- [ ] **Loading:** every async UI shows a spinner, skeleton, or progress indicator within 200ms of starting.
- [ ] **Form submission:** the submit button disables on submit, shows "Saving…" or a spinner, and surfaces a success or error toast/banner on completion.
- [ ] **Empty state:** lists and tables render an explicit empty-state message (not a blank box).
- [ ] **Error state:** failed loads render an error message with a retry affordance — not a silent failure or infinite spinner.

### Forms (especially long or complex)
- [ ] Forms longer than ~6 fields are grouped under headings or **collapsible sections**.
- [ ] Multi-step forms have a visible progress indicator (step N of M).
- [ ] Validation errors appear **next to the field that failed**, not only at the top.
- [ ] Labels are above inputs on mobile (not beside).
- [ ] Submit button is reachable without long-scrolling — use a sticky footer button for long forms.
- [ ] `inputMode` and `autocomplete` attributes are set on inputs where appropriate (`email`, `tel`, `numeric`, `one-time-code`).

### Accessibility quick-pass
- [ ] All form fields have a `<label>` or `aria-label`.
- [ ] All icon-only buttons have `aria-label`.
- [ ] Page has a single `<h1>`; heading levels are sequential.
- [ ] Body text contrast ≥ 4.5:1 on its background.

## How to verify

The dev server is already running. Use the HTTPS proxy port — Firebase Auth and other secure-context features require HTTPS, and Playwright MCP is launched with `--ignore-https-errors` so the self-signed cert is accepted:

```bash
PROXY_PORT=$(grep PROXY_PORT .symphony-ports | cut -d= -f2)
echo "https://localhost:$PROXY_PORT"
```

### Playwright MCP tools

Key tools (all prefixed `mcp__playwright__`):

| Tool | Use |
|---|---|
| `browser_navigate` | Go to a URL. Auto-creates a page on first call. |
| `browser_resize` | Set viewport — call this first to set mobile dimensions. |
| `browser_snapshot` | Returns a structured accessibility/DOM snapshot. Preferred over screenshots for inspecting structure — gives stable `ref` ids you can use with `browser_click` / `browser_fill_form`. |
| `browser_take_screenshot` | Save a PNG. Returns a file path. |
| `browser_click` | Click an element by `ref` from `browser_snapshot`. |
| `browser_fill_form` | Fill multiple form fields in one call. |
| `browser_type` | Type into a single field. |
| `browser_console_messages` | Surface client-side errors and warnings. |
| `browser_network_requests` | Confirm loaders fired, count round-trips for the perf pass. |
| `browser_evaluate` | Run arbitrary JS in the page context. |
| `browser_wait_for` | Wait for text or selector before continuing. |

### Verification procedure (per affected route)

```text
1. browser_resize → width=375, height=667           (iPhone SE)
2. browser_navigate to https://localhost:<PROXY_PORT>/<route>
3. browser_wait_for (until page is idle)
4. browser_snapshot                                  (inspect structure / a11y)
5. browser_console_messages                          (fail on uncaught errors)
6. browser_take_screenshot                           (mobile)
7. For each interactive element:
     browser_click  (or browser_fill_form + click submit)
     browser_take_screenshot                         (verify loading state)
     browser_wait_for + browser_take_screenshot      (verify success/error state)
8. browser_resize → width=1024, height=768          (desktop)
9. browser_take_screenshot                           (desktop)
```

Run this for every page you changed and every page that depends on a changed component. Attach the screenshots to the Linear ticket via the upload flow in `{{ symphony.root }}/docs/LINEAR_UPLOAD.md` — batch them into one comment per page.

### If the MCP fails to start
1. Try `browser_evaluate` with `() => 1` to confirm tools are loaded.
2. If unavailable, log the error in the workpad and document the gap explicitly — do not claim verification you didn't perform.

## When you find UX issues outside ticket scope

If a fix is impractical inside this ticket (e.g. an entire page needs redesign), file a Linear Backlog ticket and link it from the workpad. Fix only what is directly produced or worsened by your change.

## Record in workpad

```
Mobile UX pass on <commit SHA>:
- Pages verified: <list>
- Viewports tested: 375px, 1024px
- Forms exercised (valid + invalid): <list or "none">
- Loading/submission feedback verified: <yes/no per form>
- Issues found and fixed in this PR: <list>
- Backlog tickets filed for out-of-scope UX issues: <links or "none">
- Screenshots attached to Linear ticket: <comment URLs>
```
