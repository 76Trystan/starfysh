---
'@sfysh/ir': minor
'@sfysh/compiler': minor
'@sfysh/runtime': minor
'@sfysh/playwright-adapter': patch
'@sfysh/verifier': minor
'@sfysh/parser': minor
---

Security fixes ahead of the healer. Several of these reject input that was accepted before, so read the notes for each package you use.

**@sfysh/ir.** `validateWorkflow`, `validateStep`, `isWorkflow` and `isStep` now enforce three rules on top of the JSON Schema. Control characters (line breaks, tabs, and the rest of U+0000 to U+001F plus U+007F) are rejected in `name`, `description` and step `intent`. Step ids must be unique across the whole workflow, including steps nested in `guard` and `loop` bodies. Every `{ secret }` and `{ param }` reference must be declared in the workflow's `secrets` or `parameters`. Failures use the new keywords `controlCharacter`, `uniqueStepId`, `undeclaredSecret` and `undeclaredParam`. The schema files and `IR_VERSION` are unchanged; the control-character rule moves into the schema with the next minor IR version.

**@sfysh/compiler.** Fixes a code-injection bug: a line break in a step `intent`, or in the workflow `name` or `description`, ended the generated `//` comment and the rest of the text was emitted as code. Comment text now has every control character and Unicode line separator replaced with a space, and all string values are written with full escaping, so no IR field can change the structure of the generated file. A value containing a line break previously failed with a raw `SyntaxError` from the formatter and now compiles correctly. Formatter failures are wrapped in `CompilerError`. A `{ param }` value now throws `CompilerError` instead of emitting a reference to an undefined `params` variable, because the runtime does not carry workflow parameters yet. `vault` is destructured whenever any step reads a secret.

**@sfysh/runtime.** `ctx.redact` now matches each secret in its JSON-escaped, percent-encoded, form-encoded and base64 forms as well as its raw form. Before this, a secret containing `"` or `\` was written to cassettes unredacted, and a percent-encoded secret in a URL was missed. Outputs returned by `drainOutputs()` and written by `flushOutputs()` have their strings passed through `redact`. `RunResult.error.cause` is now a non-enumerable property: it is still readable for triage, but `JSON.stringify` and object spread skip it, so the raw error cannot ride into a log by accident. Secrets shorter than four characters are resolved but not registered for redaction, and a `SFYSH_SHORT_SECRET` process warning is emitted once per name; replacing such short values rewrote unrelated text. New export: `MIN_REDACTABLE_SECRET_LENGTH`.

**@sfysh/playwright-adapter.** `wrapWorkflowForTest` no longer re-throws the raw error on failure. It throws a new error with the original name and with the message and stack redacted, so a vault secret quoted in a Playwright call log does not reach the test reporter or CI logs.

**@sfysh/verifier.** `RecordingResult.cassette()` throws `CassetteError` when a query key contains a value the registered redactor would scrub. Keys cannot be redacted without breaking replay lookups, so the recorder now refuses to write the secret to disk. Replay outputs are redacted through the runtime change above.

**@sfysh/parser.** A literal typed into a field that looks like a credential is no longer copied into the IR. The parser replaces it with a vault reference, declares the secret name in `workflow.secrets`, and reports it. `parse()` and `chainsToSteps()` return a new `warnings: ParseWarning[]` list covering both lifted credentials (`literal-secret`) and literal fill values that were kept (`literal-fill`); warnings never contain the literal value. Step ids are now numbered with one counter across loop bodies, so nested steps no longer collide with top-level ids.
