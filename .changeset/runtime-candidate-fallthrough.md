---
'@sfysh/runtime': minor
---

Ranked selector candidates now work at run time, and a run says when it only passed on a fallback.

- New `tryCandidates(ctx, info, candidates, action)` runs an element action against each candidate in rank order until one succeeds. Generated code and the verifier's IR interpreter both use it. If every candidate fails, the primary's error is thrown and attributed to the primary.
- A step that passes on a candidate after the first is recorded as degraded: `RunResult.degraded` lists `{ stepId, candidateIndex, selector }` for each one. A run can be `ok` and degraded; it means the primary selectors are breaking. The field is absent when nothing degraded.
- `StepInfo` and `FailureAttribution` gain `candidateIndex`, so a failure says which ranked candidate was in use.
- `step()` now passes its `info` to the body (`async (info) => ...`). Bodies that ignore the argument are unaffected.
- `WorkflowContext` gains `recordDegraded` and `degraded()`. Contexts built with `createWorkflowContext` have them; a hand-built `WorkflowContext` object must add them.
- New exports: `tryCandidates`, `CandidateLookup`, `DegradedStep`.
