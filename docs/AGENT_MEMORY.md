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

### Rule markers and confidence

Rules added by the meta-improve pass carry a trailing HTML-comment marker so the workflow can score them over time instead of letting memory only grow:

```
- subcollection reads inside loaders must use limit(N) <!-- mem:firestore-loader-limit added=2026-05-01 sources=TEA-4181 confidence=2 -->
```

Each retrospective records `memory_feedback` per relevant rule (`reinforced` / `violated` / `stale`; see `prompts/RETROSPECTIVE.md`). The meta-improve pass then **promotes** proven rules (raises `confidence`), **strengthens** rules agents keep missing (more prominent placement), and **retires** stale ones (deletes the rule and its marker). Markers are invisible to readers and carry no meaning for an agent acting on the rule — they exist only for this feedback loop. Hand-written rules need no marker; an operator may add one to opt a rule into scoring.

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

## When this file is missing the thing you need

Don't assume the absence of a rule means "no rule". Read the closest existing pattern in the codebase. If you make a judgement call that a future ticket would benefit from, capture it as a retrospective `proposed_workflow_change` so the meta-improve pass can add it here.
