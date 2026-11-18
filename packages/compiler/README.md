# @sfysh/compiler

Takes a validated Starfysh workflow (the IR) and emits deterministic Playwright TypeScript. The same input produces the same output byte for byte, every run. That property is what makes the generated scripts safe to review, diff, and commit alongside hand-written code.

The compiler is not a model. It is a small template renderer that pulls data out of the IR and fills in a fixed set of patterns. The intelligence happens upstream (the agent that authored the workflow) and downstream (the healer that patches it). This package exists to keep that middle step boring on purpose.

## What is in the box

| Export                  | Purpose                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `compile(workflow)`     | Takes a validated `Workflow` (from `@sfysh/ir`) and returns `{ source, workflowId }`.                         |
| `compileUnknown(data)`  | Convenience wrapper that validates first. Use this when reading a workflow from disk and the shape is unsure. |
| `CompileResult`         | Return type for both entry points: `{ source: string; workflowId: string }`.                                  |
| `createTemplater()`     | Advanced. Returns a configured templater instance you can call directly.                                      |
| `Templater`             | Type for the templater instance.                                                                              |
| `CompilerError`         | Thrown when validation fails or templating encounters a malformed step. Carries a human-readable message.     |
| `formatTypeScript(src)` | Formats a TypeScript string with the compiler's pinned Prettier config. Exposed for advanced uses.            |
| `COMPILER_VERSION`      | Semantic version of this package.                                                                             |

## Installation

```sh
pnpm add @sfysh/compiler @sfysh/ir
```

`@sfysh/ir` is a peer dependency in practice; the compiler consumes its types and validators.

## Usage

```ts
import { readFile } from 'node:fs/promises';
import { compileUnknown, CompilerError } from '@sfysh/compiler';

const raw = JSON.parse(await readFile('workflow.json', 'utf8'));

try {
  const { source, workflowId } = await compileUnknown(raw);
  console.log(`// Compiled ${workflowId}`);
  console.log(source);
} catch (err) {
  if (err instanceof CompilerError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
```

If you already have a validated `Workflow` object (for example from `validateWorkflow` in `@sfysh/ir`), skip the convenience wrapper and call `compile` directly:

```ts
import { compile } from '@sfysh/compiler';
import { validateWorkflow } from '@sfysh/ir';

const check = validateWorkflow(raw);
if (!check.valid) throw new Error('invalid workflow');

const { source } = await compile(check.value);
```

## What the generated code does

- **Loops** go through the runtime's `forEachItem` and `whileHolds`, which stop at the step's `maxIterations` (default 100) with `LoopLimitError`.
- **`foreach` bodies are scoped to the item.** Every target inside the body is looked up within the current item (`item.getByRole(...)`), not the whole page.
- **`timeoutMs`** on a step is passed to the runtime's `step()`, which fails the step with `StepTimeoutError` when it runs longer.
- **Conditions** in `guard`, `wait`, `assert` and `loop.while` are evaluated by the runtime's `conditionHolds`, the same evaluator as pre and post checks.
- **Ranked selectors fall through.** A `click` or `fill` with more than one usable candidate calls the runtime's `tryCandidates`, which tries each in rank order and records a pass on a fallback as degraded (`RunResult.degraded`). A step with one usable candidate acts on it directly. `visual` candidates are left out. `extract` steps and `foreach` anchors use the primary only.

These are the same helpers the verifier's IR interpreter uses, and a parity test holds the two to the same page calls. Generated code needs a `@sfysh/runtime` that exports them.

## What the compiler refuses

Besides an invalid workflow, `compile()` throws `CompilerError` for:

- an extract `bind` that is a reserved word, a name generated code already uses (`page`, `ctx`, `emit`, `vault`, `item`, `extracted` and the runtime helpers), or a name bound twice;
- a `role` selector with any part it cannot read, such as `button[name='Go' disabled]`;
- a `responseStatus` condition in a guard, wait, assert or loop, until response tracking lands;
- a `{ param }` value, until the runtime supports parameters.

## Package layout

```
src/
  index.ts        # barrel: public API
  compile.ts      # compile() and compileUnknown() entry points
  templater.ts    # Handlebars templates and the CompilerError class
  format.ts       # formatTypeScript(): Prettier wrapper with pinned config
test/
  compile.test.ts # covers every step kind and the determinism invariant
```

## Determinism contract

For any valid `Workflow`, `compile(workflow)` returns the same source byte for byte on every call. The `compile.test.ts` suite enforces this by compiling the same input twice and asserting equality.

If you edit `templater.ts` or `format.ts`, the determinism test is the first thing to run. Non-determinism in codegen is a trust failure: a user who regenerates a script should not get a diff for no reason.

## Why Handlebars instead of a model

Three reasons.

1. The generated code is boring and repetitive by design. Templates are the right shape for this.
2. A model can produce code that looks right and has a subtle bug. A template with a locked schema cannot.
3. Determinism. See the contract above.

The agent is in the loop upstream (authoring the IR) and in the healer loop (patching the IR). It is never asked to write the final TypeScript.
