---
'@sfysh/runtime': minor
---

Breaking: remove `classifyError`, `FailureKind`, and the `kind` field on `RunResult.error`. Triage moves out of the runtime into the new `@sfysh/triage` package so the classifier can stay surface-agnostic and extend to the HTTP surface in Phase 2 without touching the browser runtime. `RunResult.error` now carries only the raw shape (`message`, `cause`, `stepId?`, `phase?`); callers classify failures by passing that error to `triage.classify({ error, step?, postconditions?, response? })`, which returns `{ kind, reason }`.

Migration for existing consumers:

```ts
// before
if (result.error?.kind === 'flake') retry();

// after
import { classify } from '@sfysh/triage';
const { kind } = classify({ error: result.error?.cause });
if (kind === 'flake') retry();
```
