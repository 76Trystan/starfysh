---
'@sfysh/compiler': minor
---

Generated `click` and `fill` steps now fall through their ranked selector candidates instead of using only the first. It needs the matching `@sfysh/runtime` minor release, which provides `tryCandidates`.

- A step with more than one usable candidate compiles to `tryCandidates(ctx, info, [...], (locator) => locator.click())`, trying each candidate in rank order. `visual` candidates are left out; the others keep their rank, so a degraded step reports where its candidate sits in the IR.
- A step with a single usable candidate compiles exactly as before.
- `extract` steps and `foreach` anchors still use the primary candidate: a read that matches nothing returns empty rather than failing, so there is nothing to fall through on.
- `info` and `tryCandidates` are now refused as extract `bind` names, alongside the other names generated code uses.
