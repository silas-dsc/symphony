# Performance, efficiency, and reliability pass

Apply this to every file you touch that runs in a hot path: route loaders, request handlers, Cloud Functions, batch jobs, components rendered on initial page load. For pure helpers, types, or one-off scripts, skip.

Performance work is measure-first. Don't optimise speculatively — find real costs in the path of your change.

## Read-path efficiency

- [ ] **No N+1 queries.** If you fetch a list and then per-item, batch with `getAll`, an `IN` query, a `Promise.all`, or a single denormalised read.
- [ ] **No duplicate reads in one request.** If the same Firestore document is read twice in a loader/handler, hoist the read.
- [ ] **Every Firestore query on a user-growable collection has a `limit()` or `where(...)` constraint.** Unbounded `getDocs(collection(...))` on a collection that can grow without bound is a latent bug.
- [ ] **Loaders return only what the UI uses.** Don't return entire Firestore documents if the component reads three fields — the wire payload, the parse cost, and the hydration cost all add up.

## Loop / compute

- [ ] **No nested loops over the same collection** (O(n²)). Build a `Map` keyed by id once, then look up.
- [ ] **No `.find` inside `.map`** over the same array. Same fix — build a `Map`.
- [ ] **Hoist invariant work out of loops.** Date parsing, regex compilation, lookups that don't depend on the iteration variable belong outside.
- [ ] **No synchronous blocking work in request handlers** beyond a few ms (large JSON parse, sync crypto, sync file I/O).

## Caching

- [ ] **Memoise per-request** values computed from request inputs only — don't recompute the same thing twice in one loader.
- [ ] **Cache-Control on loaders** where data is public and slowly-changing. Don't ship `no-store` by default.
- [ ] **React: memoise only when there's measured cost.** `useMemo` / `React.memo` add maintenance overhead — apply them to expensive children, not speculatively.

## API call reduction

- [ ] **Move client-side `fetch` on mount into the route loader** when the data is needed for first paint. One round-trip beats two.
- [ ] **Combine round-trips** where the same backend offers a batched endpoint. Storyblok, Firestore, internal Cloud Functions — check for batch APIs before looping.
- [ ] **Cloud Function → Cloud Function calls pay a cold-start tax.** Extract shared logic into a module imported by both, rather than chaining function calls.

## Reliability

- [ ] **Async operations have error handling at a meaningful boundary.** Don't swallow errors silently with empty `.catch(() => {})`.
- [ ] **External API calls have a timeout and a retry policy** where the operation is idempotent. Don't retry payments or non-idempotent writes.
- [ ] **No race conditions on read-then-write.** Any read-modify-write on the same Firestore document uses `runTransaction`.
- [ ] **Pagination is correct under concurrent writes** — use cursor-based pagination, not offset, for anything user-modifiable.

## Measure before claiming a win

If you optimise, capture before/after numbers:

```bash
# Time a route loader (the SSL proxy port is in .symphony-ports)
PROXY_PORT=$(grep PROXY_PORT .symphony-ports | cut -d= -f2)
time curl -sk -o /dev/null "https://localhost:$PROXY_PORT/<route>"
```

For Firestore query cost, log read counts in dev or check the Firebase emulator UI.

## Record in workpad

Append to `.claude/workpad.md` (Notes section):

```
Performance pass on <commit SHA>:
- Hot-path files touched: <list>
- N+1s found and fixed: <list or "none">
- Caching/memoisation added: <list or "none">
- Round-trips eliminated: <count>
- Measurements: <before/after where relevant, or "no perf changes claimed">
```

If you suspect a perf issue but it's outside ticket scope, file a Linear Backlog ticket and note it in `.claude/workpad.md`. Don't silently expand scope.
