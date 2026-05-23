# Structured debugging skill

Invoked when:
- The Tester reports a scenario failure and the first re-attempt at fixing it didn't work.
- A test that previously passed is now red and the cause isn't obvious from the diff.
- `pnpm typecheck` or `pnpm lint` reports an error you don't immediately understand.
- Behaviour in the dev server differs from your mental model after a code change.

The instinct is to make more changes and hope. That's the failure mode. The fix is one structural pattern: **reproduce, isolate, hypothesise, change one thing, verify**. No step is skippable.

## The five steps

### 1. Reproduce — get the failure on demand

Write down the **shortest** way to trigger the failure. If it requires "click around for a bit", you do not yet have a reproduction.

- For a unit test failure: `pnpm --filter <pkg> test -- --run <test-file>`. Capture the full output.
- For an E2E / Tester failure: the exact sequence of Steps from the matrix row, with the role and viewport.
- For a typecheck/lint failure: the exact `pnpm typecheck` or `pnpm lint` output, the file and line number it points at.
- For runtime behaviour: the route, the actions, and the observable difference (toast text wrong, network 500, console error message).

Record the reproduction at the top of `.claude/debug-<scenario>.md` so you can re-run it without thinking.

If you cannot reproduce reliably, **stop**. An intermittent failure that you fix by guessing is a failure you'll see again. Run the reproduction five times in a row. If it fails fewer than five out of five, you've found a flake — investigate that flake before "fixing" any behaviour.

### 2. Isolate — find the smallest input that fails

Halve the input space until you can't halve any more. Concretely:

- **Code:** comment out half of the change, re-run the reproduction. If still failing, the bug is in the un-commented half. Iterate. If now passing, it's in the commented half. Iterate.
- **Data:** strip the test fixture / request payload to the minimum that still triggers the bug.
- **State:** what's different about the failing case vs a similar passing one? (User role? Logged-in vs out? Empty list vs populated? Mobile vs desktop?)
- **Git:** `git bisect` if the failure is on a previously-passing commit.

When you can describe the bug as "fails iff `<minimal condition>`", you're done isolating.

### 3. Hypothesise — write down the cause before you change anything

In `.claude/debug-<scenario>.md`:

```
## Hypothesis
The failure happens because <one sentence: the cause>.
I expect <specific code path / specific value> to be <wrong how>.
If this is right, then `<observable check>` will show `<observed value>`.
```

The check is the critical part. Make a falsifiable prediction. Examples:

- "Add `console.log(invoiceId)` at line 42. If hypothesis is right, it prints `null` on the failing case."
- "Run with `DEBUG=firestore:* pnpm dev`. If hypothesis is right, the query log shows two reads when one is expected."
- "Inspect the React DevTools props. If hypothesis is right, `onSubmit` is `undefined`."

Run the check. **Now** you know whether the hypothesis is right. If wrong, write a new hypothesis. Do not silently re-hypothesise — each hypothesis goes on the page.

### 4. Change one thing — the minimum fix

Once the hypothesis is confirmed, make the smallest change that addresses it. No "while I'm here" refactors. No defensive paranoia (adding null-checks everywhere is debugging fear, not engineering).

If the fix is more than ~10 lines, ask: am I addressing the symptom or the root? If it's the symptom, stop — find the root.

### 5. Verify — re-run the reproduction and the suite

- Re-run the exact reproduction from step 1. It must now pass.
- Re-run the entire test suite for the touched package (`pnpm --filter <pkg> test -- --run`). No new red.
- Re-run `bash {{ symphony.root }}/scripts/verify-changes.sh`. Must pass.
- If the failure was an E2E scenario, re-run that scenario via the Tester (or manually walk the Steps) at the same viewport the Tester used.

Record the verification result in `.claude/debug-<scenario>.md`:

```
## Verified at <commit SHA>
- Reproduction now: passes
- <pkg> test suite: green
- VERIFY: pass
```

## Anti-patterns to refuse

- **"Add a try/catch and log the error."** That's a coping mechanism, not a fix. The error is information; understand it before swallowing it.
- **"Restart the dev server and try again."** Only after step 1 (reproduce) succeeded with a fresh server. If restarting "fixes" the bug, you have a state-leak bug — that's the actual ticket.
- **"Cast to `any` to silence the type error."** The type error is the compiler doing its job. Read it. The fix is to give the value the type it actually has, not to lie.
- **"Update the snapshot."** A snapshot mismatch is a test asking you to confirm intent. Read the diff, confirm the new shape is what you want, and only then accept it — with a note in `.claude/workpad.md` explaining the new shape.
- **"Add another conditional to cover the case."** If you're adding conditions reactively, the data model is wrong. Rethink the shape, don't decorate it.

## When to escalate

If you reach step 3 and the hypothesis keeps being wrong (≥ 3 hypotheses falsified in a row), you don't have enough mental model of the code. Stop. Go read:

- The full file containing the failing logic — every line, not just the function.
- Every caller of the function (`rg -F "<funcName>(" packages/<pkg>/src`).
- The data flow from input to failure point — what passes through it, where each field originates.

After 30 minutes of reading without progress, append to `.claude/workpad.md`:

```
## Debug escalation
- Scenario: <matrix row #> / <test name> / <error>
- Hypotheses falsified: <list with one-line summaries>
- Files read: <list>
- Why I'm stuck: <one sentence>
```

Hand off to a code review (if you were the Developer) or to human triage (if you've exhausted the Developer ↔ Tester round-trip budget).

## Definition of Done

- [ ] `.claude/debug-<scenario>.md` exists with Reproduction, Hypothesis, Verified sections populated.
- [ ] The reproduction is one short command or one short user-action sequence.
- [ ] The fix is the minimum change that addresses the confirmed hypothesis — no scope expansion.
- [ ] The reproduction now passes; the package's test suite is green; VERIFY: pass.
