---
'@sfysh/verifier': minor
---

The IR interpreter now uses the runtime's `forEachItem`, `whileHolds`, `conditionHolds` and `step()` deadline, the same helpers generated code calls, so the two executors share one implementation of loop caps, timeouts and flow conditions.

- A `foreach` body is scoped to the current item, as in generated code. Before, both executors looked targets up across the whole page.
- A flow condition the page cannot answer now fails with the runtime's `UnsupportedConditionError` instead of `InterpreterError`.
- A `role` selector with a part that cannot be read fails with `InterpreterError` instead of being run without it.
- `LoopLimitError`, `StepTimeoutError` and `DEFAULT_MAX_ITERATIONS` now come from `@sfysh/runtime` and are re-exported unchanged.
- The cassette fake page and the recorder support the new scoped `Locator` lookups.
