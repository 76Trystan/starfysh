---
'@sfysh/ir': minor
'@sfysh/compiler': minor
'@sfysh/verifier': minor
---

The contracts a healer is built against: single-step patches, outputs from extract steps, and two verifier fixes.

**@sfysh/ir.** New single-step patch support. `StepPatch` (defined by the new `patch.schema.json`) describes a proposed change to one step: `replace`, `insert_before` or `insert_after`, anchored to a step id and bound to the workflow it was written against by `baseHash`. `validatePatch(data)` checks an unknown value. `applyPatch(workflow, patch)` returns a new, validated workflow and its hash, or the reasons it refused; it never throws and never mutates. It refuses a patch for another workflow, a patch whose `baseHash` does not match, an unknown anchor step, a `before` that differs from the current step, and any result that fails validation. Applying the same patch twice is refused. `hashWorkflow` and `hashStep` return a stable `sha256:` hash of behaviour, ignoring `metadata`, `$schema` and key order. `findStep`, `replaceStep`, `insertStep` and `listStepIds` address steps by id through nested `guard` and `loop` bodies. `diffPatch` and `diffStep` return field-level changes as JSON Pointers. Also new: `planExtract(schema)`, the shared rule for how an extract schema is read from the page. The barrel now exports the validators by name; the public names are unchanged.

**@sfysh/compiler.** Generated code changes in three ways; recompile to pick them up.

- Every `extract` step now adds its value to the run's outputs as `emit.output({ <bind or step id>: value })`, after its post checks. Before this, extracted values were bound or discarded and never reached the outputs, so compiled workflows produced none.
- An extract schema of `{ type: 'array', items: { type: 'object', properties } }` is now read as a table with one typed column per property. It was previously read as a flat list of text, which returned the whole table as one string. A schema the runtime cannot read from a page (a single object, an array of numbers, a column typed as an object) now throws `CompilerError` instead of generating code that fails at run time.
- Generated code no longer calls `ctx.flushOutputs()` when the workflow declares `outputs`. Whoever runs the workflow decides what happens to the outputs: call `ctx.drainOutputs()` to read them or `ctx.flushOutputs()` to write them to stdout or `COMPILE_OUTPUT_FILE`. Flushing inside generated code emptied the buffer before a verifier could compare outputs across runs.

**@sfysh/verifier.**

- Fixed: `compareOutputs` threw `SyntaxError: "undefined" is not valid JSON` when a field was present in one run and absent in another. Such a field is now reported as drift with `missing: true` on its `DriftField`, and the human report shows it as `(absent)`. An absent field is kept distinct from an explicit `null`.
- New `VerifyOptions.runTimeoutMs`. A replay that runs longer is recorded as failed with a `RunTimeoutError` and the verifier moves on, so a hung runner can no longer hang the whole verify. No limit by default. Also accepted by `replayFromCassette`.
- The interpreter emits extract outputs the same way generated code does, and shares the extract schema rule, so the output-stability check now has real values to compare under either executor. The parity test compares outputs as well as page calls.
