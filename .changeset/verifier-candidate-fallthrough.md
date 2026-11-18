---
'@sfysh/verifier': minor
---

The IR interpreter now falls through ranked candidates by default, matching compiled code, which now does the same.

- `candidates` defaults to `'fallthrough'` (was `'first'`). Pass `candidates: 'first'` to prove a step's primary selector works on its own, as the healer does when it verifies a patch.
- Fallthrough goes through the runtime's `tryCandidates`, so both executors share one implementation, and the parity test now covers a fallback pass and an all-candidates failure.
- A visual primary candidate is refused, as compiled code refuses it, instead of being skipped. Visual fallbacks are still skipped.
- A step with one usable candidate acts on it directly, as compiled code does.
- `ReplayOutcome.degraded` lists steps that passed on a fallback candidate, and `ReplayOutcome.error` carries `candidateIndex`.
