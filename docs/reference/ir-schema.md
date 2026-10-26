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
| `timeoutMs` | `integer` | no | Maximum milliseconds before the verifier marks this step as possibly stuck. |

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
| `maxIterations` | `integer` | no | Hard cap to prevent runaway loops (default: 100). |

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

`role` format: `button[name="Submit"]`. `testid` format: `submit-button`. `visual` format: an embedding reference such as `emb_4f2a`.

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

---

## Versioning

The schema version is `irVersion: "1.0.0"` and the constant `IR_VERSION` in `@sfysh/ir` tracks this. The contract:

- **Patch** (`1.0.x`): documentation or description-only changes. No structural change.
- **Minor** (`1.x.0`): new optional fields. Existing workflows remain valid.
- **Major** (`x.0.0`): breaking structural change. Requires a migration function and a corresponding bump to `IR_VERSION`. The CI IR-break check fails any PR that modifies the schema without a matching migration.

Do not change the schema casually. Every package that consumes the IR will need updating on a breaking change.
