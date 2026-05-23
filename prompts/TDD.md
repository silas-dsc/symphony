# Test-driven development pass

Applied during Phase 3 (Develop) to **every code change that adds new logic or fixes a bug**. The discipline is small and non-negotiable: the test that proves the change works is written **before** or **alongside** the implementation, not after.

This is not the Functional Test Matrix — that's the Tester's E2E coverage in Phase 4. This is the developer-side unit / integration test that lives in the codebase forever and runs on every CI build.

## When to apply

| Change shape | TDD action |
|---|---|
| Bug fix | Write the failing test that reproduces the bug **first**. Watch it fail. Then fix the bug. Watch it pass. The test stays as the regression guard. |
| New utility / helper / hook | Write the test alongside the implementation (same commit). Cover the happy path and at least one edge case. |
| New API endpoint / Cloud Function | Test the request/response contract. Mock external dependencies; don't reach Firestore in a unit test. |
| New route loader / action | Test the data-shape the loader returns and the error paths it can hit. |
| New component with behaviour (form, validation, conditional render) | Testing Library: render + assert the user-visible behaviour for each branch. |
| Pure refactor (no behaviour change) | No new test, but the existing test suite must stay green — that **is** your safety net. |
| Tailwind / styling-only change | No unit test required. Mobile UX checks in `MOBILE_UX.md` cover it. |

If you are not sure whether a change needs a test: it does. The default is yes, and the burden of justification is on skipping.

## Bug-fix protocol (most common path)

1. **Reproduce in code.** Write a single test that fails for the reason the bug was reported. Don't generalise — capture the specific case. Name the test after the symptom: `it("does not infinite-loop when invoiceId is null")`.
2. **Run it and confirm it fails for the right reason.** A test that fails because of a typo in the test itself doesn't prove the bug exists. Read the failure output before you proceed.
3. **Make the minimum change** in the implementation that turns the test green. No "while I'm here" cleanup.
4. **Run the test suite for the package** (`pnpm --filter <pkg> test -- --run`). Other tests must stay green. If something else breaks, you've found related behaviour the original report didn't mention — surface it.
5. **Commit the test and the fix together.** The diff tells the reviewer the test failed before and passes after.

## New-feature protocol

1. **Sketch the API surface first** — function signature, component props, loader/action shape. The Architect Plan should have these.
2. **Write the test for the smallest slice** of behaviour (one happy path). Watch it fail because the implementation doesn't exist yet.
3. **Implement the slice.** Test passes.
4. **Add the next slice's test → implement → repeat.** Edge cases and error paths come last.
5. **Run the package's full test suite** before moving on. Don't leave testing as a "later" pass — later means never.

## What the test must do

- **Cover observable behaviour, not implementation details.** Don't test "function calls helper internally"; test "given input X, function returns Y".
- **Run fast.** A single unit test should complete in < 100ms. If it doesn't, you're testing too much in one case — split it.
- **Be deterministic.** No `Date.now()`, `Math.random()`, network calls, or wall-clock timeouts in unit tests. Inject the clock; mock the network; use `vi.useFakeTimers()` if Vitest.
- **Be readable.** A reviewer reading the test name alone should know what behaviour is being asserted.

## What the test must NOT do

- **Hit production services.** No real Firestore reads, no real Firebase Auth, no real Storyblok. Use mocks, emulators, or fakes.
- **Depend on test order.** Each test stands alone. If you can't reorder tests freely, you have shared state — fix it.
- **Update a snapshot without inspection.** A failing snapshot is the test asking you to verify the new shape is correct. `--update-snapshots` is not a fix; it's a hand-wave.

## When a test is hard to write

Stop and ask why. Usually it means:

- The code under test is doing too much — extract the pure logic into a function and test that.
- The code reaches into too many global dependencies — refactor to pass dependencies in.
- The behaviour you're trying to assert is not actually observable — rethink what the change is supposed to do.

Don't lower the test bar to fit awkward code. Reshape the code so it's testable.

## Skipping a test

If you genuinely cannot write a test (e.g. the change is a one-line copy of a constant, or an asset move with no logic), record why in `.claude/workpad.md`:

```
TDD skip — <file>: <one-sentence justification>
```

The Code Reviewer in Phase 4.5 reads this. Skips without a justification are Blocking findings.

## Definition of Done

- [ ] Every behavioural change has a test that fails on `origin/main` and passes on `HEAD`, or a `TDD skip` note with justification.
- [ ] `pnpm --filter <touched-pkg> test -- --run` is green for every package the diff touches.
- [ ] No `.skip`, `.only`, `xit`, `xdescribe` left in the diff — VERIFY catches these but the developer should catch them first.
- [ ] No snapshots were updated without a one-line note in `.claude/workpad.md` explaining the diff is intentional.
