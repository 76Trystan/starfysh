# @sfysh/ir

The typed intermediate representation at the centre of Starfysh. Every other package in the workspace depends on this one; this package depends on nothing else in the workspace.

If you are new to the project, see ADR 0001 (IR-first architecture) and ADR 0007 (JSON Schema as source of truth) in `docs/architecture/decisions/` for the design rationale.

## What is in the box

| Export                                                                    | Purpose                                                                                                         |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `IR_VERSION`                                                              | Semantic version of the IR schema this package publishes. Workflows carry an `irVersion` field that must match. |
| `Workflow`, `Step`                                                        | TypeScript types for the top-level workflow document and the step union. Generated from the JSON schemas.       |
| `Navigate`, `Click`, `Fill`, `Extract`, `Wait`, `Assert`, `Guard`, `Loop` | Per-action step interfaces. Use these when narrowing a `Step`.                                                  |
| `Target`, `SelectorCandidate`                                             | Shared types describing how a step locates an element.                                                          |
| `ValueSource`                                                             | Union of literal string, parameter reference, or vault secret reference used by `fill` and `navigate`.          |
| `Condition`                                                               | Union of six boolean-condition kinds used in `pre`, `post`, `assert`, `guard.if`, and `loop.while`.             |
| `JSONSchemaFragment`                                                      | Loose type for user-authored JSON Schema fragments (parameters, outputs, extraction schemas).                   |
| `validateWorkflow(data)`                                                  | Runtime validation returning `{ valid, value, errors }`. Does not throw.                                        |
| `validateStep(data)`                                                      | Same, scoped to a single step. Used by the healer when patching one step at a time.                             |
| `isWorkflow(data)`, `isStep(data)`                                        | Boolean type guards for use at package boundaries.                                                              |

## Usage

```ts
import { validateWorkflow, type Workflow, type Step } from '@sfysh/ir';

const result = validateWorkflow(parsedJson);
if (!result.valid) {
  for (const err of result.errors) {
    console.error(`${err.path}: ${err.message}`);
  }
  process.exit(1);
}

const workflow: Workflow = result.value;
for (const step of workflow.steps) {
  if (step.action === 'click') {
    // step is narrowed to Click
    console.log(step.target.candidates[0]);
  }
}
```

## Package layout

```
src/
  index.ts                             # barrel: re-exports everything below
  types.ts                             # generated from the JSON schemas, do not edit
  validate.ts                          # Ajv-based validators and type guards
  schema/
    workflow.schema.json               # top-level workflow document
    step.schema.json                   # step union with 8 action kinds
    examples/
      supplier-portal.workflow.json    # reference example from the design doc
scripts/
  regen-types.mjs                      # regenerates types.ts from the schemas
test/
  validate.test.ts                     # 23 tests covering accept + reject cases
```

## Regenerating types

Any time a schema in `src/schema/` changes, run:

```sh
pnpm --filter @sfysh/ir regen-types
```

This invokes `scripts/regen-types.mjs`, which:

1. Compiles `workflow.schema.json` (and its cross-file reference to `step.schema.json`) via `json-schema-to-typescript`.
2. Prepends a `JSONSchemaFragment` type alias.
3. Post-processes the output to replace useless `{}` placeholders on JSON-Schema-fragment fields (`Workflow.parameters`, `Workflow.outputs`, `Extract.schema`) with `JSONSchemaFragment`.
4. Writes the result to `src/types.ts`.

Commit the regenerated `types.ts` in the same change as the schema edit so a reader can see both halves of the diff.

## Versioning policy

`IR_VERSION` follows semver:

- **Patch** for internal clarifications that do not affect generated types or validation behaviour.
- **Minor** for additive changes: new optional fields, new step kinds, new condition kinds, new selector kinds.
- **Major** for breaking changes: removed fields, renamed fields, tightened constraints that would reject previously-valid workflows.

Any major bump must ship with a migration helper (not yet implemented; see the ToDo).

## Why this file matters more than most

The IR schema is the hardest thing to change in the codebase. Every downstream package (compiler, verifier, healer, runtime, CLI) assumes the shape defined here. Breaking changes propagate painfully. Minor additive changes are cheap; major breaking changes are expensive. Design the schema conservatively and bump the major version only when there is no alternative.
