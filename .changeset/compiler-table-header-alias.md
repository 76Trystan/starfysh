---
'@sfysh/compiler': patch
'@sfysh/verifier': patch
---

Extract steps whose table columns carry `x-header` aliases now compile to `emit.table` with a column spec, and the IR interpreter reads them the same way. Output for workflows without aliases is byte-identical.
