# IR Schema Reference

The Starfysh intermediate representation (IR) is the single source of truth for a compiled workflow. Every other component reads or writes the IR: the compiler emits it, the verifier replays it, the healer patches it, and the runtime executes it. Nothing acts directly on generated code.

This document describes `irVersion: 1.0.0`. Breaking changes require a major version bump and a migration.

---

## Workflow

A workflow document is a JSON object validated against `packages/ir/src/schema/workflow.schema.json`.

| Field | Type | Required | Description |
|---|---|---|---|
| `irVersion` | `string` (semver) | yes | IR schema version this document conforms to. Must match `IR_VERSION` from `@sfysh/ir` at parse time. |
| `id` | `string` | yes | Stable identifier, lowercase, kebab-case or snake_case (`^[a-z][a-z0-9_-]{2,63}$`). Must be unique within a registry. |
| `name` | `string` | yes | Human-readable name, 1-200 characters. |
| `description` | `string` | no | Prose description surfaced to the healer as context when a step fails. Worth writing. |
| `parameters` | `object` | no | Typed inputs the workflow accepts at run time. Keys are parameter names; values are JSON Schema fragments. |
| `secrets` | `string[]` | no | Names of secrets resolved from the vault at run time. Literal secret values must never appear here. |
| `outputs` | `object` | no | JSON Schema fragment describing the expected output shape. Used by the verifier for stability checks. |
| `steps` | `Step[]` | yes | Ordered list of steps. At least one required. |
| `metadata` | `object` | no | Free-form metadata (author, tags, source trace id, etc.). Not interpreted by the compiler. |

---

## Step

Each step in `steps` has a set of common fields plus action-specific fields. The `action` property is the discriminator.

### Common fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | yes | Step identifier (`^[a-z][a-z0-9_]{2,63}$`), unique within the workflow. Referenced in semantic diffs and healer output. |
| `intent` | `string` | yes | Natural-language description of what this step achieves. Load-bearing: the healer uses this to re-derive the step when selectors fail. Write something a human would understand cold. |
| `action` | `string` (enum) | yes | One of `navigate`, `click`, `fill`, `extract`, `wait`, `assert`, `guard`, `loop`. |
| `pre` | `Condition[]` | no | Preconditions that must hold before this step runs. Failure routes to triage, typically classified as a site change or auth decay. |
| `post` | `Condition[]` | no | Postconditions that must hold after this step completes. These are what make healing tractable; without them, the healer cannot classify failures. |
| `onFail` | `string` (enum) | no | What to do on failure: `retry`, `escalate_to_healer` (default), `stop`, `continue`. |
| `timeoutMs` | `integer` | no | Maximum milliseconds the step may take, including its pre and post checks and any nested steps. Past it the step fails with `StepTimeoutError`. `0` means no limit. |

### Action types

#### `navigate`

Navigate to a URL.

| Field | Type | Required |
|---|---|---|
| `url` | `ValueSource` | yes |
| `waitUntil` | `"load"` \| `"domcontentloaded"` \| `"networkidle"` | no (default: `"load"`) |

#### `click`

Click an element.

| Field | Type | Required |
|---|---|---|
| `target` | `Target` | yes |

#### `fill`

Type a value into a form field.

| Field | Type | Required |
|---|---|---|
| `target` | `Target` | yes |
| `value` | `ValueSource` | yes |

#### `extract`

Pull structured data out of the page into a typed shape.

| Field | Type | Required | Description |
|---|---|---|---|
| `target` | `Target` | yes | Element to extract from. |
| `schema` | `object` | yes | JSON Schema fragment the extracted value must conform to. The verifier uses this for stability checks. |
| `bind` | `string` | no | Variable name to bind the result to for use by later steps or as workflow output. |

The `schema` decides how the page is read. The compiler and the interpreter share one rule (`planExtract` in `@sfysh/ir`):

| Schema | Read | Value |
|---|---|---|
| `{ "type": "string" }` | Text of the first matched element | `string` or `null` |
| `{ "type": "array" }`, or with `"items": { "type": "string" }` | Text of every matched element | `string[]` |
| `{ "type": "array", "items": { "type": "object", "properties": { ... } } }` | The target is read as a table. Each property is a column, matched to a header cell by name. | One object per row |
| A bare column map, for example `{ "sku": "string", "qty": "number" }` | Same table read | One object per row |

For a table, each property's `type` sets how its cells are coerced: `string`, `number`, `integer` (read as a number) or `boolean`. Any other property type is refused, as is any schema outside this table: the compiler throws `CompilerError` and the interpreter fails the step. Nothing is read from the page in that case.

**Matching columns to headers.** Each property is matched to a header cell by its name. A header with exactly that text (after trimming) wins. When there is none, a header that differs only in case, spacing or Unicode compatibility form matches, so a property `sku` reads a column headed `SKU`. When the page uses different words, name them with `x-header`, a string or a list of strings, tried after the property name in the same way:

```json
{
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "sku": { "type": "string", "x-header": ["Stock code", "Item code"] },
      "qty": { "type": "integer", "x-header": "Quantity on hand" }
    }
  }
}
```

If two header cells match one property at the same step (two columns headed `SKU` and `sku `, or the name and an alias both present), the step fails with an `ExtractionError` naming both. It never picks one, because a guessed column is a wrong-column read. An `x-header` that is empty, blank or not made of strings makes the schema unsupported. Aliases are only available in the JSON Schema form; a bare column map matches by name.

Every `extract` step adds one entry to the run's outputs: an object with a single key, the `bind` name (or the step `id` when there is no `bind`), holding the extracted value. An extract inside a loop adds one entry per iteration. The entry is added after the step's `post` conditions pass, so a step whose postcondition fails contributes nothing. The verifier's output-stability check compares these entries across runs.

#### `wait`

Wait for a condition or a fixed duration. Prefer `forCondition` over `millis`; fixed waits are brittle.

| Field | Type | Required |
|---|---|---|
| `forCondition` | `Condition` | no |
| `millis` | `integer` | no |

At least one of `forCondition` or `millis` should be provided.

#### `assert`

Assert a condition explicitly. Fails the workflow immediately if the condition is false.

| Field | Type | Required |
|---|---|---|
| `condition` | `Condition` | yes |

#### `guard`

Conditional execution. Runs `then` if `if` holds; runs `else` if provided and `if` does not hold. The canonical use case is optional UI elements like cookie banners.

| Field | Type | Required |
|---|---|---|
| `if` | `Condition` | yes |
| `then` | `Step[]` | yes |
| `else` | `Step[]` | no |

#### `loop`

Repeated execution. Exactly one of `foreach` or `while` must be present.

| Field | Type | Required | Description |
|---|---|---|---|
| `foreach` | `Target` | one of | Iterates over all elements matching the target. |
| `while` | `Condition` | one of | Repeats until the condition stops holding. |
| `do` | `Step[]` | yes | Steps to run each iteration. |
| `maxIterations` | `integer` | no | Hard cap to prevent runaway loops (default: 100). The run fails with `LoopLimitError` on the iteration after the cap. |

Inside a `foreach` body, every step's `target` is looked up within the current item, not across the page, and so are the targets of steps nested in a guard or another loop in that body. A nested `foreach` target is looked up within the outer item. Conditions (`pre`, `post`, a guard's `if`, a wait's `forCondition`) are always evaluated against the whole page.

---

## Supporting types

### Target

A ranked list of ways to locate the element a step acts on. Candidates are tried in order; the first one that resolves wins.

```json
{
  "candidates": [
    { "kind": "role",   "value": "button[name='Sign in']" },
    { "kind": "testid", "value": "login-submit" },
    { "kind": "css",    "value": "#login button[type='submit']" }
  ]
}
```

Candidate order should follow: `role` > `testid` > `text` > `label` > `css` > `visual`. Role-based locators survive redesigns best because they encode semantic meaning rather than layout. Visual embeddings are the last-resort fallback.

### SelectorCandidate

| Field | Type | Values |
|---|---|---|
| `kind` | `string` | `role`, `testid`, `text`, `label`, `css`, `visual` |
| `value` | `string` | The selector string in the form expected by `kind`. |

`role` format: a role, then attributes in brackets: `button[name="Submit"]`, `heading[level=2][name='Orders']`, `button[name=Submit exact=true]`. Values may be quoted with either quote, or unquoted; an unquoted value that is all digits is a number and `true` or `false` is a flag, except for `name` and `description`, which are always text. The compiler refuses a role value with any part it cannot read, rather than dropping it. `testid` format: `submit-button`. `visual` format: an embedding reference such as `emb_4f2a`.

### ValueSource

A value supplied to a step. Three forms:

```json
"some literal string"
```

```json
{ "param": "month" }
```

```json
{ "secret": "supplier_portal_pass" }
```

Secrets are always passed by name and resolved from the vault at run time. Literal secret values must never appear in the IR.

### Condition

A boolean assertion about page state. Used in `pre`, `post`, `assert`, `guard.if`, and `loop.while`.

| Form | Description |
|---|---|
| `{ "urlMatches": "string" }` | Regex or substring the current URL must match. |
| `{ "urlEquals": "string" }` | Exact URL the page must have (URI format). |
| `{ "selectorVisible": "string" }` | CSS selector that must resolve to a visible element. |
| `{ "selectorAbsent": "string" }` | CSS selector that must not resolve to any element. |
| `{ "textPresent": "string" }` | Text that must appear anywhere on the page. |
| `{ "responseStatus": integer }` | HTTP status (100-599) the most recent navigation or XHR must have returned. |

---

## Example

The canonical reference workflow is at `packages/ir/src/schema/examples/supplier-portal.workflow.json`. It covers login with secrets, a conditional guard for a cookie banner, navigation, and structured data extraction.

Abbreviated shape:

```json
{
  "irVersion": "1.0.0",
  "id": "wf_acme_stock",
  "name": "Acme supplier portal, monthly low-stock extraction",
  "parameters": {
    "month": { "type": "string", "pattern": "^\\d{4}-\\d{2}$" }
  },
  "secrets": ["supplier_portal_user", "supplier_portal_pass"],
  "outputs": { "type": "array", "items": { ... } },
  "steps": [
    {
      "id": "step_01_goto_login",
      "intent": "Open the supplier portal login page.",
      "action": "navigate",
      "url": "https://portal.acmesupply.com/login",
      "post": [{ "selectorVisible": "form[action*='login']" }]
    },
    ...
  ]
}
```

---

## Validation

`@sfysh/ir` exports Ajv-based validators:

```ts
import { validateWorkflow, isWorkflow, IR_VERSION } from '@sfysh/ir';

const result = validateWorkflow(json);
if (!result.valid) {
  console.error(result.errors);
}

// Type guard form
if (isWorkflow(json)) {
  // json is typed as Workflow
}
```

`validateWorkflow` returns `{ valid: boolean; errors?: ErrorObject[] }`. `isWorkflow` is a plain TypeScript type guard.

### Rules the validator enforces beyond the schema

The validators are stricter than the JSON Schema files. A document can pass a plain JSON Schema check against `workflow.schema.json` and still be rejected by `validateWorkflow`. Three rules apply, and each failure is reported with its own `keyword`:

| Rule | `keyword` | Why |
| --- | --- | --- |
| `name`, `description`, and every step `intent` must not contain control characters (U+0000 to U+001F, and U+007F). That covers line breaks and tabs. | `controlCharacter` | The compiler writes these fields into `//` comments. A line break would end the comment and turn the rest of the text into code. |
| Step ids must be unique across the whole workflow, including steps nested in `guard` and `loop` bodies. | `uniqueStepId` | Patches and diffs address a step by its id. A duplicate makes that address ambiguous. |
| Every `{ "secret": name }` must be listed in the workflow's `secrets`, and every `{ "param": name }` must be a key of `parameters`. | `undeclaredSecret`, `undeclaredParam` | A workflow should not be able to read a secret it never declared. |

`validateStep` applies the first two rules to the step it is given (and anything nested inside it). It cannot check declarations, because those live on the workflow.

The control-character rule moves into the schema files with the next minor IR version. Until then, use `validateWorkflow` as the source of truth, not a standalone schema validator.

---

## Patches

A patch is a proposed change to exactly one step. It is its own document type, defined by `patch.schema.json` next to the workflow and step schemas, and it is what a healer produces and a person reviews.

```json
{
  "workflowId": "wf_acme_stock",
  "baseHash": "sha256:4777377e284f...",
  "stepId": "step_04_submit_login",
  "op": "replace",
  "before": { "id": "step_04_submit_login", "...": "the step as it was" },
  "after": { "id": "step_04_submit_login", "...": "the step as proposed" },
  "rationale": "The button was renamed from 'Sign in' to 'Log in'.",
  "confidence": 0.9
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `workflowId` | `string` | yes | Workflow the patch applies to. |
| `baseHash` | `string` | yes | `hashWorkflow` of the workflow the patch was written against, as `sha256:` plus 64 hex characters. |
| `stepId` | `string` | yes | The step the patch is anchored to. |
| `op` | `string` | yes | `replace`, `insert_before` or `insert_after`. |
| `before` | `Step` | for `replace` | The anchored step as it was. Must equal the step currently in the workflow. |
| `after` | `Step` | yes | The new step. A replacement keeps the id of the step it replaces. An inserted step carries an id not used elsewhere. |
| `rationale` | `string` | yes | Why the change is proposed, for the reviewer. At most 2,000 characters. |
| `confidence` | `number` | no | Author's confidence from 0 to 1. |

There is no remove operation. A patch changes or adds one step; it never deletes one.

```ts
import { applyPatch, diffPatch, hashWorkflow, validatePatch } from '@sfysh/ir';

const result = applyPatch(workflow, patch);
if (result.ok) {
  result.workflow; // a new, validated workflow; the input is untouched
  result.hash; // hashWorkflow of the patched workflow
} else {
  result.errors; // why it was refused
}
```

`applyPatch` never throws and never mutates its input. It refuses a patch that is not a valid `StepPatch`, names another workflow, has a `baseHash` that does not match the workflow it is applied to, is anchored to a step that does not exist, has a `before` that differs from the current step, or produces a workflow that fails validation. Applying the same patch a second time is refused, because the first application changed the hash.

`hashWorkflow` covers everything that affects behaviour and leaves out `metadata` and `$schema`. Key order does not affect it. `findStep`, `replaceStep`, `insertStep` and `listStepIds` address steps by id through nested `guard` and `loop` bodies. `diffPatch` and `diffStep` return field-level changes as JSON Pointers, ready for a renderer.

`applyPatch` checks that a patch is well formed and applies cleanly. It does not decide whether the change is acceptable. Limits on what an automated healer may change belong to the healer.

---

## Versioning

The schema version is `irVersion: "1.0.0"` and the constant `IR_VERSION` in `@sfysh/ir` tracks this. The contract:

- **Patch** (`1.0.x`): documentation or description-only changes. No structural change.
- **Minor** (`1.x.0`): new optional fields. Existing workflows remain valid.
- **Major** (`x.0.0`): breaking structural change. Requires a migration function and a corresponding bump to `IR_VERSION`. The CI IR-break check fails any PR that modifies the schema without a matching migration.

Do not change the schema casually. Every package that consumes the IR will need updating on a breaking change.
