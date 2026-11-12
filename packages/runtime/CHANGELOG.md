# @sfysh/runtime

## 0.4.0

### Minor Changes

- 143561c: Breaking: remove `classifyError`, `FailureKind`, and the `kind` field on `RunResult.error`. Triage moves out of the runtime into the new `@sfysh/triage` package so the classifier can stay surface-agnostic and extend to the HTTP surface in Phase 2 without touching the browser runtime. `RunResult.error` now carries only the raw shape (`message`, `cause`, `stepId?`, `phase?`); callers classify failures by passing that error to `triage.classify({ error, step?, postconditions?, response? })`, which returns `{ kind, reason }`.

  Migration for existing consumers:

  ```ts
  // before
  if (result.error?.kind === 'flake') retry();

  // after
  import { classify } from '@sfysh/triage';
  const { kind } = classify({ error: result.error?.cause });
  if (kind === 'flake') retry();
  ```

## 0.3.0

### Minor Changes

- 1587a1b: Add secret redaction (ADR 0013). `ctx.vault(name)` now returns a branded `Secret` string, resolved values register on the per-run context, and `ctx.redact(input)` replaces every registered value with `[REDACTED:<name>]`. `runner.run()` routes `error.message` through `ctx.redact` before attaching it to `RunResult.error`; the raw error remains available on `error.cause`. `Secret` is a phantom brand with zero runtime cost, so existing call sites that treat the return of `vault()` as a plain string continue to work.

  Cassette-side scrubbing is a follow-up tracked alongside the Phase 2 recorder work because the recorder is constructed before the context exists.

## 0.2.0

### Minor Changes

- 04d4f04: Adopt `WorkflowContext` as the per-run container (ADR 0010).

  `@sfysh/runtime` now exposes `createWorkflowContext({ page, vaultResolver? })`. The free exports `vault`, `emit`, `flushOutputs`, `drainOutputs`, and `setVaultResolver` are removed. Vault resolution and the output buffer are bound to the returned context and do not leak between concurrent runs in the same process.

  `@sfysh/compiler` codegen now wraps workflows as `async (ctx) => { const { page, vault, emit } = ctx; ... }` with destructuring scoped to the fields the workflow actually uses, and calls `ctx.flushOutputs()` when the workflow declares outputs. Generated scripts require this version of `@sfysh/runtime` or newer.

  `@sfysh/playwright-adapter.wrapWorkflowForTest` constructs the context from the Playwright page internally and accepts an optional `vaultResolver`.

  Workflow id collisions now throw `WorkflowIdCollisionError` with the offending id attached. A `resetWorkflows()` helper is exported for test cases that need to re-register.

  BREAKING: direct callers of the removed free exports need to build a context first (`const ctx = createWorkflowContext({ page }); ctx.vault('name'); ctx.emit.output(...);`). `@sfysh/verifier`'s `RunnerFn` signature changes from `(page, workflow)` to `(ctx, workflow)`; custom backend modules used with `compile verify` must update their runner function to destructure `page` off the context. `PageDisposer` receives the context too, so `dispose` callers can reach `ctx.page` for cleanup.

## 0.1.2

### Patch Changes

- 46159c6: Parameterise `WorkflowFn`, `workflow()`, and `getWorkflow()` by context type (`TCtx = Page`). Defaults preserve existing browser-only behaviour; the generic parameter leaves the door open for future surfaces to register workflows against a different context shape without a signature break.

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
