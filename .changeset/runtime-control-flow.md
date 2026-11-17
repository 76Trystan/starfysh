---
'@sfysh/runtime': minor
---

New control-flow helpers that generated code and the verifier's IR interpreter now share, so a workflow behaves the same whichever one runs it:

- `step(ctx, info, body, { timeoutMs })` enforces a step's `timeoutMs`, failing with `StepTimeoutError`.
- `forEachItem` and `whileHolds` run loops and stop at `maxIterations` with `LoopLimitError`. `DEFAULT_MAX_ITERATIONS` is 100, the IR schema default.
- `conditionHolds` evaluates guard, wait, assert and loop conditions with the same evaluator as pre and post checks. It throws `UnsupportedConditionError` for a condition the page cannot answer.
- `withTimeout` is the deadline `step()` uses.

`LoopLimitError` and `StepTimeoutError` moved here from `@sfysh/verifier`, which re-exports them.

**Breaking for custom backends:** `Locator` now requires `getByRole`, `getByTestId`, `getByText` and `getByLabel`, the same lookups `Page` has. Generated code uses them to scope a `foreach` body to the current item. Playwright's `Locator` already has all four, so `@sfysh/playwright-adapter` users need do nothing. A hand-written backend must add them.
