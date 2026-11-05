# Functional test: {{target_label}}

You are testing a change to the Team DSC site the way a real user would, in a real browser, and collecting evidence. Base URL: **{{base_url}}**

- Ticket: {{issue_ref}}
- PR: {{pr_ref}}
- Files changed: {{changed_files}}

## Ticket
{{issue_text}}

## 1. Plan (keep it short)
List 3–8 checks that prove the change works: the ticket's acceptance points first, then one quick regression check of the area the changed files touch. Skip anything you can't reach from the browser.

## 2. Test with the chrome-devtools MCP
Screen widths for this change: **{{viewports}}**
- Desktop is 1440×900, tablet is 768×1024 (touch), and mobile is 390×844 (touch). Use `emulate` / `resize_page` to switch, and enable touch emulation for tablet and mobile.
- For every check at every width, save a screenshot with `take_screenshot` and `filePath` set to `{{screenshot_dir}}/<nn>-<short-name>-<desktop|tablet|mobile>.png`. Take one per check and width that shows the result, not one per click.
- Look at the console and network panels for errors and failed requests on the pages you test.
- A check passes only if you saw it work. If you couldn't get there, mark it `not_checked` and say why. Never mark something passed that you inferred.

### Can people reach and use it?
At each width you test, make every button, link and form field the change touches reachable with that device's standard controls:
- **Desktop:** reach it with Tab and Shift+Tab, with a visible focus ring. Enter or Space activates it. Escape closes dialogs and menus. Nothing traps focus.
- **Tablet and mobile:** each element is visible, or can be scrolled into view, without sideways page scrolling. Nothing sticky or fixed covers it. Tap targets are at least 44×44 px with room between them. Fields open the right keyboard (email, number, tel). Dialogs fit the screen and can be closed.
- Record each of these as its own check, for example "Save button reachable by keyboard (desktop)".

### Matching the design
{{design_rules}}

## Accounts, payments and data
- Sign in with the test accounts in these environment variables:
  - `FUNCTIONAL_TEST_SUPER_ADMIN_EMAIL` / `_PASSWORD`
  - `FUNCTIONAL_TEST_ADMIN_EMAIL` / `_PASSWORD`
  - `FUNCTIONAL_TEST_LEARNER_EMAIL` / `_PASSWORD`
- Read them with `printenv NAME` and type them straight into the form. **Never** echo a password, put it in a file, or include it in your output.
- If a flow needs a new user, sign up as `silas+ft-{{run_id}}-<n>@teamdsc.com.au`.
- Payments: only with the coupon **DSFREE**. Never enter a card number. If DSFREE doesn't cover a payment step, stop that check and mark it `not_checked`.
- Name anything you create `Symphony test {{run_id}}`.
- When done, delete or cancel what you created, as far as the UI allows. List anything you couldn't clean up under `leftovers`.
- Don't change anything that belongs to real users or real teams. Don't send messages or invitations to anyone outside `@teamdsc.com.au`.
{{target_rules}}

## 3. Fixing
{{fix_rules}}

When you fix a layout or reachability problem, use a proven responsive pattern rather than a one-off workaround:
- **Wide tables:** on mobile, show each row as a stacked card with labelled fields, or put the table in a horizontal-scroll container with a sticky first column.
- **Navigation and toolbars:** collapse into a menu or overflow (⋯) button.
- **Forms:** a single column on mobile, with labels above the fields and full-width primary buttons.
- **Dialogs:** full-screen sheets on mobile.
- **Touch targets:** make them bigger with padding rather than a smaller font.

Reuse the app's existing components and Tailwind breakpoints where they already solve the problem.

## 4. Report
Finish with a short summary, then **exactly one** fenced block tagged `ft-result` holding JSON:

```ft-result
{
  "verdict": "pass" | "fail" | "partial",
  "summary": "one or two plain sentences",
  "checks": [{ "name": "…", "status": "pass" | "fail" | "not_checked", "evidence": "what you saw" }],
  "screenshots": [{ "file": "{{screenshot_dir}}/01-….png", "label": "…" }],
  "comparisons": [{ "label": "Dashboard, desktop", "actual": "{{screenshot_dir}}/….png", "design": "{{screenshot_dir}}/design-….png", "combined": "{{screenshot_dir}}/compare-….png" }],
  "fixed_commits": [{ "sha": "…", "message": "…" }],
  "problems": ["what is wrong, where, and how to reproduce"],
  "leftovers": ["test data you couldn't remove"]
}
```

Use `pass` only if every check passed. Use `partial` if nothing failed but some checks are `not_checked`.
