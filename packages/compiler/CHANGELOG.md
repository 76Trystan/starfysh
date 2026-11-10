# @sfysh/compiler

## 0.2.0

### Minor Changes

- 04d4f04: Adopt `WorkflowContext` as the per-run container (ADR 0010).

  `@sfysh/runtime` now exposes `createWorkflowContext({ page, vaultResolver? })`. The free exports `vault`, `emit`, `flushOutputs`, `drainOutputs`, and `setVaultResolver` are removed. Vault resolution and the output buffer are bound to the returned context and do not leak between concurrent runs in the same process.

  `@sfysh/compiler` codegen now wraps workflows as `async (ctx) => { const { page, vault, emit } = ctx; ... }` with destructuring scoped to the fields the workflow actually uses, and calls `ctx.flushOutputs()` when the workflow declares outputs. Generated scripts require this version of `@sfysh/runtime` or newer.

  `@sfysh/playwright-adapter.wrapWorkflowForTest` constructs the context from the Playwright page internally and accepts an optional `vaultResolver`.

  Workflow id collisions now throw `WorkflowIdCollisionError` with the offending id attached. A `resetWorkflows()` helper is exported for test cases that need to re-register.

  BREAKING: direct callers of the removed free exports need to build a context first (`const ctx = createWorkflowContext({ page }); ctx.vault('name'); ctx.emit.output(...);`). `@sfysh/verifier`'s `RunnerFn` signature changes from `(page, workflow)` to `(ctx, workflow)`; custom backend modules used with `compile verify` must update their runner function to destructure `page` off the context. `PageDisposer` receives the context too, so `dispose` callers can reach `ctx.page` for cleanup.

## 0.1.1

### Patch Changes

- a358a3a: Launch polish. The `0.1.0` tarballs were published before each `package.json` carried its full metadata; `0.1.1` fixes the npm registry pages. Every published package now ships with `description`, `keywords`, `license`, `homepage`, `bugs`, `author`, `engines`, and a `prepublishOnly` guard that rebuilds `dist/` before publish. No code changes to the runtime, compiler, IR, or adapter. The release workflow has also moved from `NPM_TOKEN` to npm Trusted Publishing (OIDC) with build provenance; `0.1.1` is the first release attempting the OIDC path.
- Updated dependencies [a358a3a]
  - @sfysh/ir@0.1.1

## 0.1.0

### Minor Changes

- fbd91ec: Initial public release of the Starfysh Phase 0 packages: IR schema and validators, deterministic templated compiler, workflow runtime with vault and assertions, and the Playwright compatibility adapter.

### Patch Changes

- Updated dependencies [fbd91ec]
  - @sfysh/ir@0.1.0
