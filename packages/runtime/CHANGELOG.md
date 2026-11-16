# @sfysh/runtime

## 0.6.0

### Minor Changes

- 244876f: `EnvVaultResolver` now reads secrets from prefixed environment variables. `vault('portal_password')` reads `SFYSH_SECRET_PORTAL_PASSWORD`. Before this, it read `PORTAL_PASSWORD`, which meant a workflow definition could name any variable in the environment, such as `aws_secret_access_key`, and type it into a page.

  Nothing breaks in this release. When the prefixed variable is not set, the resolver still reads the unprefixed one and emits a `DeprecationWarning` with the code `SFYSH_UNPREFIXED_SECRET`, once per secret name. That fallback will be removed in a later release, so rename your variables to `SFYSH_SECRET_<NAME>` when you see the warning.

  Two new options:

  - `new EnvVaultResolver({ prefix })` sets the prefix. Setting it, even to the default, turns the fallback off. Pass `prefix: ''` to keep reading unprefixed variables on purpose, with no warning.
  - `new EnvVaultResolver({ allow })` limits the resolver to a list of secret names. Any other name throws the new `VaultSecretNotAllowedError`, which is separate from `VaultSecretMissingError` because it is not a missing credential.

  `DEFAULT_SECRET_ENV_PREFIX`, `VaultSecretNotAllowedError` and the `EnvVaultResolverOptions` type are exported.

## 0.5.1

### Patch Changes

- f7d3d06: Failure messages no longer carry terminal colour codes. `describeFailure` now strips ANSI escape sequences (colours, cursor movement and hyperlinks) from the error message and from a violated condition's `reason` before redacting them, so `RunResult.error.message` and the verifier's `ReplayOutcome.error.message` are plain text. Playwright colours parts of its error messages even when the output is not a terminal, and those codes were showing up in logs and JSON reports.

  Stripping happens before redaction. An escape sequence in the middle of a quoted value could otherwise split a registered secret so the redactor did not match it. The raw error on `cause` is unchanged.

## 0.5.0

### Minor Changes

- d1505e1: Every failed run now says which step failed, what it was doing, and what the page looked like.

  **@sfysh/runtime.** New `step(ctx, info, body)` helper that generated code wraps around each IR step. If the body throws, the error is carried in a `StepFailure` naming the step id, action, and selector in use; nested steps keep the innermost attribution. `run()` unwraps it, so `RunResult.error.cause` is still the original error and existing triage code keeps working. `RunResult.error` gains `name`, `action`, `selector`, `condition` and `reason` alongside the existing `stepId` and `phase`, and `stepId` is now set for any failure inside a step, not only a violated pre or post condition. Messages for step failures are prefixed with `[stepId]`. The `Page` interface gains an optional `snapshot(): Promise<string>` that returns the page's accessibility tree as text. When a run fails and the backend supports it, `run()` attaches the result as `RunResult.snapshot` (`{ text, truncated, originalLength }`), with secrets redacted, a 100,000 character cap, and a 5 second timeout. Capture never turns one failure into two: an unsupported backend, a thrown error, or a timeout simply leaves the snapshot off. `run()` takes a third `options` argument (`{ snapshot?: boolean | { maxChars, timeoutMs } }`). New exports: `step`, `StepFailure`, `describeFailure`, `capturePageSnapshot`, and the related types. The snapshot is untrusted page content; treat it as data.

  **@sfysh/compiler.** Generated code changes shape: each step body, including its pre and post condition checks, is wrapped in `await step(ctx, { id, action, selector }, async () => { ... })`, and `step` is added to the runtime import. An `extract` step with `bind` declares its variable outside the wrapper (`const rows = await step(...)`) so later steps can still read it. Recompile existing workflows to pick this up; generated files now require a runtime version that exports `step`.

  **@sfysh/verifier.** `ReplayOutcome.error` carries the same attribution fields as `RunResult.error` (`action`, `selector`, `condition`, `reason`), plus a non-enumerable `cause` holding the original error so a caller can pass a verify failure to triage in-process. Failed replays get a `snapshot`, captured before the page is disposed; it is shown as a one-line note in the human report and left out of the JSON report. New `VerifyOptions.snapshot` option mirrors the runtime's. New `runRegisteredWorkflow` runner executes the workflow registered under `workflow.id` and preserves step attribution; prefer it over a runner that calls `run()` and re-throws, which loses the step id. The recorder stores a snapshot under the `snapshot` key as a redacted string value and `FakePage` replays it; the cassette format version is unchanged.

  **@sfysh/playwright-adapter.** `asPage` now returns a thin proxy over the Playwright page instead of the page itself. Every existing method and property is forwarded to the real page, and the proxy adds `snapshot()`, backed by Playwright's ARIA snapshot of the document body. Code that compared `asPage(page) === page` will see `false`; calling `asPage` twice with the same page returns the same proxy.

- c785b02: Security fixes ahead of the healer. Several of these reject input that was accepted before, so read the notes for each package you use.

  **@sfysh/ir.** `validateWorkflow`, `validateStep`, `isWorkflow` and `isStep` now enforce three rules on top of the JSON Schema. Control characters (line breaks, tabs, and the rest of U+0000 to U+001F plus U+007F) are rejected in `name`, `description` and step `intent`. Step ids must be unique across the whole workflow, including steps nested in `guard` and `loop` bodies. Every `{ secret }` and `{ param }` reference must be declared in the workflow's `secrets` or `parameters`. Failures use the new keywords `controlCharacter`, `uniqueStepId`, `undeclaredSecret` and `undeclaredParam`. The schema files and `IR_VERSION` are unchanged; the control-character rule moves into the schema with the next minor IR version.

  **@sfysh/compiler.** Fixes a code-injection bug: a line break in a step `intent`, or in the workflow `name` or `description`, ended the generated `//` comment and the rest of the text was emitted as code. Comment text now has every control character and Unicode line separator replaced with a space, and all string values are written with full escaping, so no IR field can change the structure of the generated file. A value containing a line break previously failed with a raw `SyntaxError` from the formatter and now compiles correctly. Formatter failures are wrapped in `CompilerError`. A `{ param }` value now throws `CompilerError` instead of emitting a reference to an undefined `params` variable, because the runtime does not carry workflow parameters yet. `vault` is destructured whenever any step reads a secret.

  **@sfysh/runtime.** `ctx.redact` now matches each secret in its JSON-escaped, percent-encoded, form-encoded and base64 forms as well as its raw form. Before this, a secret containing `"` or `\` was written to cassettes unredacted, and a percent-encoded secret in a URL was missed. Outputs returned by `drainOutputs()` and written by `flushOutputs()` have their strings passed through `redact`. `RunResult.error.cause` is now a non-enumerable property: it is still readable for triage, but `JSON.stringify` and object spread skip it, so the raw error cannot ride into a log by accident. Secrets shorter than four characters are resolved but not registered for redaction, and a `SFYSH_SHORT_SECRET` process warning is emitted once per name; replacing such short values rewrote unrelated text. New export: `MIN_REDACTABLE_SECRET_LENGTH`.

  **@sfysh/playwright-adapter.** `wrapWorkflowForTest` no longer re-throws the raw error on failure. It throws a new error with the original name and with the message and stack redacted, so a vault secret quoted in a Playwright call log does not reach the test reporter or CI logs.

  **@sfysh/verifier.** `RecordingResult.cassette()` throws `CassetteError` when a query key contains a value the registered redactor would scrub. Keys cannot be redacted without breaking replay lookups, so the recorder now refuses to write the secret to disk. Replay outputs are redacted through the runtime change above.

  **@sfysh/parser.** A literal typed into a field that looks like a credential is no longer copied into the IR. The parser replaces it with a vault reference, declares the secret name in `workflow.secrets`, and reports it. `parse()` and `chainsToSteps()` return a new `warnings: ParseWarning[]` list covering both lifted credentials (`literal-secret`) and literal fill values that were kept (`literal-fill`); warnings never contain the literal value. Step ids are now numbered with one counter across loop bodies, so nested steps no longer collide with top-level ids.

### Patch Changes

- Updated dependencies [ec27a95]
- Updated dependencies [22cf3aa]
- Updated dependencies [c785b02]
  - @sfysh/ir@0.2.0

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
