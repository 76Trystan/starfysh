# @sfysh/parser

## 0.5.2

### Patch Changes

- Updated dependencies [61402b1]
  - @sfysh/ir@0.4.0

## 0.5.1

### Patch Changes

- Updated dependencies [1b7cbc2]
  - @sfysh/ir@0.3.0

## 0.5.0

### Minor Changes

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

- aadadf7: Dropped `expect()` assertions now surface in the `unsupported` list instead of vanishing silently. Any expect chain the condition extractor cannot translate (an unrecognised matcher like `toHaveCount`, a subject like `getByPlaceholder` that has no condition mapping, or an argument like a regex passed to `toHaveURL`) is reported with the matcher name as `method`, the 1-based source position, and the raw call text. Page-method and expect-matcher reports share the single `UnsupportedCall` list, so existing consumers need no shape changes. The package README has also been rewritten to describe the implemented parser rather than the pre-implementation scaffold.

## 0.3.0

### Minor Changes

- 656cb8e: Emit IR `extract` steps for Playwright data-read patterns.

  The parser now lifts four locator terminal methods into `extract` IR steps with weak default schemas:

  | Playwright call             | IR schema                                      |
  | --------------------------- | ---------------------------------------------- |
  | `locator.textContent()`     | `{ type: 'string' }`                           |
  | `locator.innerText()`       | `{ type: 'string' }`                           |
  | `locator.inputValue()`      | `{ type: 'string' }`                           |
  | `locator.allTextContents()` | `{ type: 'array', items: { type: 'string' } }` |

  When the call is the initializer of a `const`/`let`/`var` single-declaration statement (e.g. `const name = await page.getByTestId('user').textContent()`), the variable name is captured as the step's `bind` field so later steps and workflow outputs can reference it. Destructuring patterns and multi-declaration statements are skipped for v1.

  `locator.evaluate()` is intentionally not supported and surfaces through the existing unsupported-call list, consistent with "page content never reaches arbitrary code".

  Column-type inference for `allTextContents` (and table iteration via `for (const row of await locator('tr').all())`) are tracked as follow-up ToDo items. The parser-emitted schemas are the loosest JSON Schema shape that still gates the verifier's output-stability comparison.

## 0.2.0

### Minor Changes

- e2963cc: Surface unsupported Playwright methods instead of dropping them silently.

  Breaking: `parse(source)` now returns `{ workflow, unsupported: UnsupportedCall[] }` rather than a bare `Workflow`. Any `page.<method>()` call whose terminal method is outside the parser's supported set (`goto`, `click`, `fill`, `waitForTimeout`, `waitForSelector`, `waitForURL`) is collected into `unsupported` with its method name, 1-based source position, and the raw call text. Callers should surface the list so users know which actions were dropped from the workflow.

  Migration:

  ```ts
  // before
  const workflow = parse(source);

  // after
  const { workflow, unsupported } = parse(source);
  if (unsupported.length > 0) {
    // warn the user, e.g. CLI prints the list to stderr
  }
  ```

  `CallChain` from the walker also grew a `text: string` field (the await-stripped raw source of the call expression), which the unsupported-call reporter uses to quote user source verbatim.

## 0.1.0

### Minor Changes

- 33f0555: Initial public release. `@sfysh/parser` lifts hand-written Playwright TypeScript scripts into the Starfysh IR so existing scripts can be verified and healed by the Starfysh toolchain. Covers `page.goto`, `fill`, `click`, `waitFor*`, ranked selector extraction from `getByRole` / `getByTestId` / `getByText` / `getByLabel` / CSS locators, and condition inference from `expect().toBeVisible()`, `.toHaveURL()`, `.toHaveText()`, and related matchers.
