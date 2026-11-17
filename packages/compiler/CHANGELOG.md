# @sfysh/compiler

## 0.4.0

### Minor Changes

- 1b7cbc2: Generated code now matches the IR interpreter on loops, deadlines and conditions. It needs the matching `@sfysh/runtime` minor release.

  - Loops call the runtime's `forEachItem` and `whileHolds`, so `maxIterations` (default 100) is enforced. Before, it was ignored and a `while` loop on a page that never changed ran for ever.
  - A step's `timeoutMs` is passed to `step()` and enforced. Before, it was ignored.
  - A `foreach` body is scoped to the current item: `item.getByRole(...)` instead of `page.getByRole(...)`. Before, every iteration acted on the first match on the whole page.
  - Conditions in `guard`, `wait`, `assert` and `loop.while` are evaluated by the runtime's `conditionHolds`. Before, `urlMatches` there was compiled to `new RegExp(...)`, which threw on a pattern that is not a valid regex and never matched as a substring, unlike the same condition in `pre` or `post`.

  The compiler now refuses, with `CompilerError`:

  - an extract `bind` that is a reserved word, a name the generated function already uses (`page`, `ctx`, `emit`, `vault`, `item`, `extracted`, the runtime helpers), or a name bound twice;
  - a `role` selector with a part it cannot read. Before, `button[name=Submit]` was compiled as `getByRole('button')`, silently dropping the name. Unquoted values are now read: `level=2` as a number, `exact=true` as a flag, `name=Submit` as text.

### Patch Changes

- Updated dependencies [1b7cbc2]
  - @sfysh/ir@0.3.0

## 0.3.0

### Minor Changes

- d1505e1: Every failed run now says which step failed, what it was doing, and what the page looked like.

  **@sfysh/runtime.** New `step(ctx, info, body)` helper that generated code wraps around each IR step. If the body throws, the error is carried in a `StepFailure` naming the step id, action, and selector in use; nested steps keep the innermost attribution. `run()` unwraps it, so `RunResult.error.cause` is still the original error and existing triage code keeps working. `RunResult.error` gains `name`, `action`, `selector`, `condition` and `reason` alongside the existing `stepId` and `phase`, and `stepId` is now set for any failure inside a step, not only a violated pre or post condition. Messages for step failures are prefixed with `[stepId]`. The `Page` interface gains an optional `snapshot(): Promise<string>` that returns the page's accessibility tree as text. When a run fails and the backend supports it, `run()` attaches the result as `RunResult.snapshot` (`{ text, truncated, originalLength }`), with secrets redacted, a 100,000 character cap, and a 5 second timeout. Capture never turns one failure into two: an unsupported backend, a thrown error, or a timeout simply leaves the snapshot off. `run()` takes a third `options` argument (`{ snapshot?: boolean | { maxChars, timeoutMs } }`). New exports: `step`, `StepFailure`, `describeFailure`, `capturePageSnapshot`, and the related types. The snapshot is untrusted page content; treat it as data.

  **@sfysh/compiler.** Generated code changes shape: each step body, including its pre and post condition checks, is wrapped in `await step(ctx, { id, action, selector }, async () => { ... })`, and `step` is added to the runtime import. An `extract` step with `bind` declares its variable outside the wrapper (`const rows = await step(...)`) so later steps can still read it. Recompile existing workflows to pick this up; generated files now require a runtime version that exports `step`.

  **@sfysh/verifier.** `ReplayOutcome.error` carries the same attribution fields as `RunResult.error` (`action`, `selector`, `condition`, `reason`), plus a non-enumerable `cause` holding the original error so a caller can pass a verify failure to triage in-process. Failed replays get a `snapshot`, captured before the page is disposed; it is shown as a one-line note in the human report and left out of the JSON report. New `VerifyOptions.snapshot` option mirrors the runtime's. New `runRegisteredWorkflow` runner executes the workflow registered under `workflow.id` and preserves step attribution; prefer it over a runner that calls `run()` and re-throws, which loses the step id. The recorder stores a snapshot under the `snapshot` key as a redacted string value and `FakePage` replays it; the cassette format version is unchanged.

  **@sfysh/playwright-adapter.** `asPage` now returns a thin proxy over the Playwright page instead of the page itself. Every existing method and property is forwarded to the real page, and the proxy adds `snapshot()`, backed by Playwright's ARIA snapshot of the document body. Code that compared `asPage(page) === page` will see `false`; calling `asPage` twice with the same page returns the same proxy.

- ec27a95: The contracts a healer is built against: single-step patches, outputs from extract steps, and two verifier fixes.

  **@sfysh/ir.** New single-step patch support. `StepPatch` (defined by the new `patch.schema.json`) describes a proposed change to one step: `replace`, `insert_before` or `insert_after`, anchored to a step id and bound to the workflow it was written against by `baseHash`. `validatePatch(data)` checks an unknown value. `applyPatch(workflow, patch)` returns a new, validated workflow and its hash, or the reasons it refused; it never throws and never mutates. It refuses a patch for another workflow, a patch whose `baseHash` does not match, an unknown anchor step, a `before` that differs from the current step, and any result that fails validation. Applying the same patch twice is refused. `hashWorkflow` and `hashStep` return a stable `sha256:` hash of behaviour, ignoring `metadata`, `$schema` and key order. `findStep`, `replaceStep`, `insertStep` and `listStepIds` address steps by id through nested `guard` and `loop` bodies. `diffPatch` and `diffStep` return field-level changes as JSON Pointers. Also new: `planExtract(schema)`, the shared rule for how an extract schema is read from the page. The barrel now exports the validators by name; the public names are unchanged.

  **@sfysh/compiler.** Generated code changes in three ways; recompile to pick them up.

  - Every `extract` step now adds its value to the run's outputs as `emit.output({ <bind or step id>: value })`, after its post checks. Before this, extracted values were bound or discarded and never reached the outputs, so compiled workflows produced none.
  - An extract schema of `{ type: 'array', items: { type: 'object', properties } }` is now read as a table with one typed column per property. It was previously read as a flat list of text, which returned the whole table as one string. A schema the runtime cannot read from a page (a single object, an array of numbers, a column typed as an object) now throws `CompilerError` instead of generating code that fails at run time.
  - Generated code no longer calls `ctx.flushOutputs()` when the workflow declares `outputs`. Whoever runs the workflow decides what happens to the outputs: call `ctx.drainOutputs()` to read them or `ctx.flushOutputs()` to write them to stdout or `COMPILE_OUTPUT_FILE`. Flushing inside generated code emptied the buffer before a verifier could compare outputs across runs.

  **@sfysh/verifier.**

  - Fixed: `compareOutputs` threw `SyntaxError: "undefined" is not valid JSON` when a field was present in one run and absent in another. Such a field is now reported as drift with `missing: true` on its `DriftField`, and the human report shows it as `(absent)`. An absent field is kept distinct from an explicit `null`.
  - New `VerifyOptions.runTimeoutMs`. A replay that runs longer is recorded as failed with a `RunTimeoutError` and the verifier moves on, so a hung runner can no longer hang the whole verify. No limit by default. Also accepted by `replayFromCassette`.
  - The interpreter emits extract outputs the same way generated code does, and shares the extract schema rule, so the output-stability check now has real values to compare under either executor. The parity test compares outputs as well as page calls.

- c785b02: Security fixes ahead of the healer. Several of these reject input that was accepted before, so read the notes for each package you use.

  **@sfysh/ir.** `validateWorkflow`, `validateStep`, `isWorkflow` and `isStep` now enforce three rules on top of the JSON Schema. Control characters (line breaks, tabs, and the rest of U+0000 to U+001F plus U+007F) are rejected in `name`, `description` and step `intent`. Step ids must be unique across the whole workflow, including steps nested in `guard` and `loop` bodies. Every `{ secret }` and `{ param }` reference must be declared in the workflow's `secrets` or `parameters`. Failures use the new keywords `controlCharacter`, `uniqueStepId`, `undeclaredSecret` and `undeclaredParam`. The schema files and `IR_VERSION` are unchanged; the control-character rule moves into the schema with the next minor IR version.

  **@sfysh/compiler.** Fixes a code-injection bug: a line break in a step `intent`, or in the workflow `name` or `description`, ended the generated `//` comment and the rest of the text was emitted as code. Comment text now has every control character and Unicode line separator replaced with a space, and all string values are written with full escaping, so no IR field can change the structure of the generated file. A value containing a line break previously failed with a raw `SyntaxError` from the formatter and now compiles correctly. Formatter failures are wrapped in `CompilerError`. A `{ param }` value now throws `CompilerError` instead of emitting a reference to an undefined `params` variable, because the runtime does not carry workflow parameters yet. `vault` is destructured whenever any step reads a secret.

  **@sfysh/runtime.** `ctx.redact` now matches each secret in its JSON-escaped, percent-encoded, form-encoded and base64 forms as well as its raw form. Before this, a secret containing `"` or `\` was written to cassettes unredacted, and a percent-encoded secret in a URL was missed. Outputs returned by `drainOutputs()` and written by `flushOutputs()` have their strings passed through `redact`. `RunResult.error.cause` is now a non-enumerable property: it is still readable for triage, but `JSON.stringify` and object spread skip it, so the raw error cannot ride into a log by accident. Secrets shorter than four characters are resolved but not registered for redaction, and a `SFYSH_SHORT_SECRET` process warning is emitted once per name; replacing such short values rewrote unrelated text. New export: `MIN_REDACTABLE_SECRET_LENGTH`.

  **@sfysh/playwright-adapter.** `wrapWorkflowForTest` no longer re-throws the raw error on failure. It throws a new error with the original name and with the message and stack redacted, so a vault secret quoted in a Playwright call log does not reach the test reporter or CI logs.

  **@sfysh/verifier.** `RecordingResult.cassette()` throws `CassetteError` when a query key contains a value the registered redactor would scrub. Keys cannot be redacted without breaking replay lookups, so the recorder now refuses to write the secret to disk. Replay outputs are redacted through the runtime change above.

  **@sfysh/parser.** A literal typed into a field that looks like a credential is no longer copied into the IR. The parser replaces it with a vault reference, declares the secret name in `workflow.secrets`, and reports it. `parse()` and `chainsToSteps()` return a new `warnings: ParseWarning[]` list covering both lifted credentials (`literal-secret`) and literal fill values that were kept (`literal-fill`); warnings never contain the literal value. Step ids are now numbered with one counter across loop bodies, so nested steps no longer collide with top-level ids.

### Patch Changes

- 22cf3aa: Add an IR interpreter, so a workflow can be verified straight from its IR with no compile step.

  **@sfysh/verifier.** New `interpretWorkflow` runner and `createInterpreter(options)` factory. Both are `RunnerFn`s, so they plug into `verify()` and `replayFromCassette()` unchanged:

  ```ts
  import { verify, interpretWorkflow } from '@sfysh/verifier';

  const report = await verify(workflow, { pageFactory, runner: interpretWorkflow });
  ```

  The interpreter executes every IR action against the `Page`, using the same runtime helpers as generated code, so failures carry the same step id, action, selector and condition details. A parity test holds its sequence of page calls equal to the compiled code's. It differs from generated code in four deliberate ways: it enforces `maxIterations` on loops (default 100, per the schema) and `timeoutMs` on steps, throwing `LoopLimitError` and `StepTimeoutError`; it evaluates conditions in `guard`, `wait`, `assert` and `loop.while` with the same evaluator as pre and post checks; it leaves outputs in the context for the caller to drain instead of flushing them; and it accepts `{ param }` values through a `params` option.

  Options: `candidates: 'first' | 'fallthrough'` (default `'first'`, which matches generated code; `'fallthrough'` retries a failed `click` or `fill` with the next ranked selector candidate), `params`, and `onStep`, a callback that receives a `StepTrace` (`stepId`, `action`, `status`, `durationMs`, `selector`, `candidateIndex`, `iterations`) as each step finishes. Under `'fallthrough'`, a pass with `candidateIndex > 0` means the primary selector is broken and the compiled workflow would fail.

  **@sfysh/ir.** New export `parseRoleSelector(value)`, which reads the `role` selector format (`button[name='Sign in']`) into `{ role, options }`. The compiler and the interpreter both use it, so they cannot disagree about the format.

  **@sfysh/compiler.** Role selector parsing now comes from `@sfysh/ir`. Generated output is unchanged.

- Updated dependencies [ec27a95]
- Updated dependencies [22cf3aa]
- Updated dependencies [c785b02]
  - @sfysh/ir@0.2.0

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
