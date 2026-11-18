---
'@sfysh/verifier': minor
---

New `checkEnvelope(history, outputs, tolerance?)` checks one run's outputs against what the last passing runs had in common, the second false-heal check behind exact output matching.

- Learnt per field, with array positions folded together (`*.rows.*.qty`): JSON types, presence, a band of array lengths, a numeric range, and the form of each string (`shapeOf`: letters, digits and punctuation, so `A-001` is `a-9`).
- Tolerance exempts a field from the range check only. A tolerated field may change value, but not type, presence, length or form, which is how a read of the wrong table column is caught when that column is tolerated.
- Returns `within`, `outside` with `{ path, check, message }` deviations (messages never quote values), or `insufficient_history` below `MIN_ENVELOPE_RUNS` (3). `ENVELOPE_HISTORY_RUNS` (10) is how many runs a history is expected to keep.
- Also exported: `learnEnvelope` and the `EnvelopeCheck`, `EnvelopeDeviation`, `EnvelopeResult`, `OutputEnvelope` types.
