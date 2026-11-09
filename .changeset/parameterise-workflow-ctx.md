---
'@sfysh/runtime': patch
---

Parameterise `WorkflowFn`, `workflow()`, and `getWorkflow()` by context type (`TCtx = Page`). Defaults preserve existing browser-only behaviour; the generic parameter leaves the door open for future surfaces to register workflows against a different context shape without a signature break.
