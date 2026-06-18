# Agent memory — team-dsc

Persistent, cross-ticket knowledge the agents read **before** investigating the codebase. This file exists because past tickets failed when an agent re-discovered the same convention or hit the same trap a previous ticket already solved. Treating each ticket as a clean slate is expensive and produces inconsistent code.

This is not a substitute for reading the codebase. It is a head-start: things that aren't obvious from the source alone, but you'd save half an hour if you knew up-front.

## How agents use this file

- **Intent Analyst (Phase 1A)** reads the "Domain vocabulary" and "Roles" sections to interpret the ticket in the right language.
- **Architect (Phase 2)** reads "Architectural decisions", "Conventions", and "Common pitfalls" before drafting the Plan. If the change touches an area covered here, the Plan must reflect the rule — not re-derive it.
- **Developer (Phase 3)** reads the relevant section for the package they're modifying.
- **Code Reviewer (Phase 4.5)** uses this file as the standard the diff is measured against — a violation of a documented rule is a Blocking finding by default.

## How this file is maintained

- Additions are made by the meta-improve pass (`prompts/META_IMPROVE.md`) when a retrospective pattern names a recurring miss whose fix is "the agent didn't know about <rule>". Edits are ≤ 20 lines per PR, like other meta-improve edits.
- Operators can edit directly via normal PRs.
- Entries that no longer apply (deprecated convention, refactored area) are deleted, not commented out — the meta-improve pass surfaces stale entries when their referenced files no longer exist.

## Layout

Each section is short. Bullets are concrete: "do X" or "if Y, then Z". No prose explanations of context — link to the file that has the context if a reviewer wants to dig.

---

## Roles

- **learner** — end user. Sees `/learn/*` routes. Cannot administer anything.
- **admin** — organisation administrator. Sees `/admin/*` routes scoped to their org.
- **super-admin** — Team DSC staff. Sees every org's data; full `/admin/*` access.
- **Cloud Function** — backend service identity. Uses Firebase Admin SDK; no user context.

Login credentials and per-route role mapping live in `{{ symphony.root }}/docs/TEAM_DSC_LOGIN.md`. The Intent Analyst should resolve every "Who" to one of these four.

## Domain vocabulary

- **Cohort** — a group of learners progressing through a course together. Has a start date, a set of modules, and an admin owner.
- **Module** — one unit of learning content; lives in Storyblok.
- **Activity** — a learner-interactive piece inside a module (quiz, reflection, video).
- **Submission** — a learner's response to an activity; stored in Firestore.
- **Invite** — a pending account; becomes a User when the invitee accepts.

Don't invent synonyms. If the ticket says "students", confirm whether it means "learners". If it says "courses", confirm whether it means "modules" or "cohorts".

## Architectural decisions

- **Firestore is the source of truth for user-generated data.** Storyblok is the source of truth for editorial content (modules, activities). Don't write learner-generated data to Storyblok.
- **Route loaders are the data fetch boundary.** Components don't `fetch` on mount unless the data is genuinely deferred. If a new component needs server data, the parent route's `loader` gets it.
- **Roles are checked in the loader, not the component.** `requireRole(request, "admin")` at the top of `loader` is the gate. UI hiding is cosmetic; the loader is the truth.
- **Firestore writes that depend on a read use `runTransaction`.** Anywhere you've written `getDoc` followed by `setDoc`/`updateDoc` on the same doc, it must be a transaction.
- **Cloud Functions are deployable units.** Don't import one Function's code from another Function's entry — extract to a shared `packages/functions/src/lib/` module imported by both.

## Conventions

### File and naming

- Routes: `packages/app/app/routes/<path>.tsx` (Remix v2 flat-routes). Loader and action live in the same file as the component.
- Components: `packages/app/app/components/<area>/<ComponentName>.tsx`. One component per file.
- Hooks: `packages/app/app/hooks/use<HookName>.ts`. One hook per file.
- Tests: co-located as `<name>.test.ts(x)` next to the source file. No separate `__tests__/` directory unless the file already lives in one.

### TypeScript

- `strict: true` everywhere. No `any`. If you genuinely don't know the shape, use `unknown` and narrow.
- Discriminated unions over flag fields: `type Result = { ok: true; data: X } | { ok: false; error: Y }` is preferred to `{ ok: boolean; data?: X; error?: Y }`.
- Branded types for IDs where mixing them would be a bug: `type UserId = string & { __brand: "UserId" }`. Used for `UserId`, `OrgId`, `CohortId`, `ModuleId`.

### Styling

- Tailwind utility classes, no CSS files. Co-located with the component.
- Mobile-first: write `text-base` and then `md:text-lg`, not the other way around.
- Use Radix primitives for any component with focus management, ARIA, or keyboard nav (dialog, dropdown, popover, tooltip). Don't reinvent these.

### Forms

- React Hook Form + Zod. The Zod schema is the source of truth; the form fields derive from it.
- Server-side validation on every action. The Zod schema is re-used on the server — don't trust the client-validated payload.

### Logging

- Use the project logger (`packages/<pkg>/src/lib/logger.ts`), not `console.*`. The logger is structured (JSON in prod, pretty in dev) and routes to the right destination.
- `logger.info` for normal flow signals; `logger.warn` for recoverable anomalies; `logger.error` for must-page-on events.

## Common pitfalls

### Firestore

- `getDocs(collection(...))` without a `where` or `limit` will scan the whole collection. On `submissions` or `users`, that's tens of thousands of reads. **Always** constrain.
- Composite indexes must be declared in `firestore.indexes.json`. Adding a query with a new `where + orderBy` combination and forgetting the index will pass locally on the emulator and fail in production with `FAILED_PRECONDITION`.
- Timestamps: write `serverTimestamp()`, not `new Date()`. Read them as `Timestamp`, not `Date` — Firestore returns a class with `.toDate()`, and forgetting causes serialisation bugs at the loader boundary.

### Remix loaders & actions

- `json(data, { headers })` — always set `Cache-Control` deliberately. `no-store` is the safe default but ships unnecessary 200ms latency on data that could be `max-age=60`.
- Never `redirect()` from inside a child component — the loader/action returns the redirect, not the JSX.
- `useFetcher` re-renders the route on result; `useSubmit` does not. Pick deliberately; this has caught us before.

### Firebase Auth

- Auth state hydration is async. Don't render UI that depends on `user` before the auth listener has fired — use the `useAuthLoading()` hook to gate.
- The `In Review` preview environments share a Firebase project with prod. Don't run destructive scripts against `production-`. If you must, scope by `where("env", "==", "preview")` or run against the emulator.

### Storyblok

- The Management API rate limit is 3 req/sec. Bulk content edits must use the batch endpoints; sequential edits in a loop will 429.
- Draft vs published: `cv` query param controls cache versioning. If you change content and don't see the update, you're reading the cached published version. See `{{ symphony.root }}/docs/STORYBLOK.md`.

### Testing

- React Testing Library: prefer `findByRole` over `findByText`. Roles are stable; text changes with copy edits.
- Don't `act(async () => …)` if you can `await findBy*` instead; the modern API is enough.
- Firestore emulator state leaks across test files unless you `clearFirestoreData` between suites — do that in `beforeEach`.

## Things that look like bugs but aren't

- **Dev server takes 60s to first compile after `before_run` reinstall** — this is Remix's initial bundle, not a hang. Wait it out.
- **`.symphony-ports` survives across runs** — intentional. Restarting Symphony reuses the same ports for the same ticket.
- **Slack webhook in `.env` triggers double-posts in dev** — known. Set `NOTIFICATIONS_DISABLED=1` locally when developing notification code.

## Codebase-health tooling — adoption status

Symphony's `scripts/verify-changes.sh` lights up extra checks **automatically** when the corresponding tool is present in this workspace. Each entry below shows the current adoption state. When `VERIFY` reports `skipped` for any of these, the agent should flag it in `.claude/workpad.md` under `## Tooling gaps` and (once per missing tool) file a Linear Backlog ticket to wire it up. Don't file the same gap ticket twice.

| Check | Tool | Adopted? | Config file | What it catches |
|---|---|---|---|---|
| Dependency audit | `pnpm audit --prod --audit-level high` | yes (built into pnpm) | — | Known-vulnerable transitive npm deps. |
| SAST | `semgrep --config auto` | not yet | — | XSS via `dangerouslySetInnerHTML`, eval, NoSQL/SQL injection, prototype pollution. Adopt via `pnpm add -D -W semgrep` + ensure `semgrep` is on PATH in workspace setup. |
| Architectural boundaries | `dependency-cruiser` | not yet | `.dependency-cruiser.cjs` | "packages/app shouldn't import packages/functions/src internals" — declared as forbidden rules. Adopt via `pnpm add -D -W dependency-cruiser` + commit a config. |
| Unused exports / files | `knip` | not yet | `knip.json` or `knip.config.ts` | Files and exports nothing references. Catches orphans the diff creates. |
| Firestore rules tests | `@firebase/rules-unit-testing` + a `firestore:test` script | not yet | `firestore-tests/` directory | Rules regressions: a learner reading another learner's submissions, an admin writing super-admin-only fields. High-value because rule bugs are silent until exploited. |
| Bundle-size budget | Custom JSON budget file | not yet | `.bundle-budget.json` (map of `built-file-path → byte-limit`) | Accidental 200kb library imports that bloat a route chunk. Requires a build artefact already on disk; designed for CI rather than agent's pre-push gate. |
| Test changed-only | `vitest --changed` or `jest --changedSince` | partial | — | Skipped where neither runner is in the package's deps. team-dsc uses Jest; the script auto-uses `--changedSince`. |
| Diff-aware unused-symbol delete | `knip --reporter json` filtered to changed files | not yet | requires knip | Orphan symbols THIS diff created. |
| Accessibility (a11y) | `axe-core` loaded by Tester via `browser_evaluate` | yes (no install needed — loaded from CDN at test time) | — | Missing labels, ARIA misuse, contrast, focus-trap regressions. Serious/critical violations fail the scenario. |

### Adopting a missing tool — the supported path

Symphony ships an installer at `{{ symphony.root }}/scripts/install-verify-tools.sh` that detects, installs, and scaffolds these tools in the workspace. Run modes:

```bash
# 1) Just see what's missing — no writes, safe to run anytime.
bash {{ symphony.root }}/scripts/install-verify-tools.sh

# 2) Install the npm-installable tools (dependency-cruiser, knip,
#    @firebase/rules-unit-testing when firestore.rules is present).
#    Updates package.json + lockfile but doesn't commit.
bash {{ symphony.root }}/scripts/install-verify-tools.sh --install

# 3) Scaffold starter config files (.dependency-cruiser.cjs, knip.json,
#    firestore-tests/example.test.ts, .bundle-budget.json). Refuses to
#    overwrite existing files.
bash {{ symphony.root }}/scripts/install-verify-tools.sh --scaffold

# 4) Both, plus print the suggested commit message.
bash {{ symphony.root }}/scripts/install-verify-tools.sh --all

# 5) Preview without writes.
bash {{ symphony.root }}/scripts/install-verify-tools.sh --all --dry-run
```

`semgrep` is a Python tool and isn't auto-installed — the script prints the install command for macOS / Linux / Docker. Run the appropriate one yourself.

After running `--install` or `--scaffold`:
1. Review the diff (`git diff` + `git status`).
2. Tune the scaffolded configs — the starters are minimal, not finished.
3. Run `bash {{ symphony.root }}/scripts/verify-changes.sh` to confirm the new checks light up.
4. Commit. The script prints a suggested message that lists what it actioned.

Adoption tickets, when filed by the agent for tools the operator hasn't yet adopted, should follow this shape:
- Title: "Adopt <tool> for agent VERIFY gate"
- Description: one paragraph on what the tool catches, the install command (`bash {{ symphony.root }}/scripts/install-verify-tools.sh --install` for npm-installable tools), the config file to commit, a sample run output, a budget for cleaning up any pre-existing violations the tool surfaces on first run.

When adopting `dependency-cruiser`, `semgrep`, or `knip`, the first commit should include `// rules: <list of intentional exceptions>` for any pre-existing violations the team consciously accepts. Don't disable rules wholesale — annotate the exceptions so future violations stand out.

## Periodic codebase-health audit

For monthly or quarterly full-repo audits (not per-ticket), the operator can run heavy tools that would be too noisy in `VERIFY`:

```bash
pnpm exec knip --reporter compact    # unused files, exports, types, deps
pnpm exec depcheck                    # unused npm deps (subset of knip but faster)
pnpm exec jscpd packages/             # duplicate-code finder
```

Triage the output and file Linear Backlog tickets for the worth-fixing entries. Don't push wholesale cleanup PRs — they're hard to review. Slice into per-package or per-area tickets.

## Agent artefacts in `.gitignore`

Every workspace the agent operates in must have these patterns ignored — they're per-ticket state, not deliverables, and committing them by accident pollutes both the diff and the eventual PR review:

| Pattern | What it is |
|---|---|
| `.claude/` | Inter-agent artefacts (intent, plan, matrix, workpad, qa-results, code-review, debug, screenshots). |
| `.symphony-figma/` | Figma intake outputs (manifest, classifications, per-screen specs). |
| `.symphony-ports` | Per-workspace port allocations (`APP_PORT`, `PROXY_PORT`). |
| `.symphony-app.pid` | PID of the workspace's dev server process. |
| `.symphony-proxy.pid` | PID of the workspace's SSL proxy process. |

To add the missing patterns idempotently:

```bash
bash {{ symphony.root }}/scripts/install-verify-tools.sh --scaffold
```

It checks each pattern individually (not the wrapping comment) so it doesn't duplicate entries you've already added under a different heading. When run for the first time, it inserts a marker-delimited block (`# >>> Symphony agent artefacts ... # <<<`) so future runs can identify and skip the section.

## Cleaning up historically-committed artefacts

If the codebase has accumulated stray files over previous tickets — build outputs, `.DS_Store`, coverage reports, oversized binaries outside asset directories — surface them with:

```bash
bash {{ symphony.root }}/scripts/install-verify-tools.sh --audit-tracked
```

Read-only. Prints each candidate path with the reason (output directory, OS junk, image >100kb in non-asset path, large binary, etc.) and the `git rm --cached <path>` command to remove it from the index without deleting locally. The operator coordinates the cleanup — these removals affect everyone who pulls, so they need to be batched into a deliberate PR rather than slipped into a feature ticket.

The per-PR gate complementing this is in `scripts/verify-changes.sh` → `tracked_artefacts` check, which fails the build when a ticket diff *adds* new files matching the same heuristics. So new accumulation is blocked at the door, and existing accumulation is surfaced for deliberate triage.

## When this file is missing the thing you need

Don't assume the absence of a rule means "no rule". Read the closest existing pattern in the codebase. If you make a judgement call that a future ticket would benefit from, capture it as a retrospective `proposed_workflow_change` so the meta-improve pass can add it here.
