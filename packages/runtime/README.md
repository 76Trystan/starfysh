# @sfysh/runtime

The library that every compiled Starfysh workflow imports. It defines the `Page` and `Locator` interfaces generated scripts run against, the `workflow()` wrapper that registers them, the `run()` executor that calls them, and a small set of helpers (`assert`, `poll`, `guard`, `vault`, `emit`) that generated code leans on.

This package is deliberately small. Every export here propagates to every generated script, so each addition is a long-term commitment. If you can keep logic out of the runtime, do.

## What is in the box

### Core

| Export             | Purpose                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `Page`, `Locator`  | Structural interfaces the generated code targets. Backend-agnostic; a Playwright page satisfies them structurally. |
| `workflow(id, fn)` | Registers a workflow by id. Generated code's top-level call.                                                       |
| `getWorkflow(id)`  | Looks up a registered workflow. Mostly for adapters and tests.                                                     |
| `listWorkflows()`  | Returns every registered workflow id.                                                                              |
| `WorkflowFn`       | Type alias for the registered function: `(page: Page) => Promise<void>`.                                           |

### Executor

| Export          | Purpose                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `run(id, page)` | Executes a registered workflow and returns a structured `RunResult`. Does not throw on workflow failure. |
| `RunResult`     | `{ workflowId, status, durationMs, error? }`. Status is `'ok'` or `'failed'`.                            |
| `FailureKind`   | Classification used by the healer's triage: `'flake' \| 'auth' \| 'site' \| 'unknown'`.                  |

### Assertions and polling

| Export              | Purpose                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `assert(cond, msg)` | Throws `AssertionError` with the given message if the condition is false. Used by step pre/postconditions. |
| `poll(fn, opts)`    | Polls until `fn` returns a truthy value or the timeout fires. Returns the value.                           |
| `AssertionError`    | Thrown by `assert`. Classified as a `site` failure by `run`.                                               |

### Secrets

| Export                    | Purpose                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `vault(name)`             | Resolves a secret by name through the active resolver. Generated code uses this; literal secrets never ship. |
| `setVaultResolver(r)`     | Swaps the active resolver. Call once at startup if you are not using the default.                            |
| `EnvVaultResolver`        | Default resolver. Reads secrets from `process.env`.                                                          |
| `VaultResolver`           | Interface for custom resolvers (`{ resolve(name): string \| undefined }`).                                   |
| `VaultSecretMissingError` | Thrown when a secret cannot be resolved. Classified as an `auth` failure by `run`.                           |

### Extraction

| Export            | Purpose                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `emit(row)`       | Buffers a row for later flush. Generated extraction steps call this.                               |
| `flushOutputs()`  | Returns the buffered rows and clears the buffer. Call this at workflow end.                        |
| `drainOutputs()`  | Alias used by some adapters.                                                                       |
| `ExtractionError` | Thrown when an extracted value fails its declared schema. Classified as a `site` failure by `run`. |
| `ColumnSchema`    | Row-column type union.                                                                             |
| `TableRow`        | Shape of a buffered row.                                                                           |

### Control flow

| Export            | Purpose                                                                         |
| ----------------- | ------------------------------------------------------------------------------- |
| `guard(cond, fn)` | Conditionally runs the function. Generated code uses this for IR `guard` steps. |

## Installation

```sh
pnpm add @sfysh/runtime
```

## Usage

Generated code imports from this package automatically:

```ts
// Generated by @sfysh/compiler
import { workflow, assert, vault, emit, flushOutputs } from '@sfysh/runtime';

workflow('supplier-portal-daily-pull', async (page) => {
  await page.goto('https://supplier.example.com/login');
  await page.getByLabel('Email').fill(vault('SUPPLIER_EMAIL'));
  await page.getByLabel('Password').fill(vault('SUPPLIER_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in' }).click();

  assert(await page.getByText('Dashboard').isVisible(), 'login did not land on dashboard');

  for (const row of await page.getByRole('table').locator('tr').all()) {
    emit({ sku: await row.locator('td.sku').innerText() });
  }
});
```

Then at execution time:

```ts
import { run } from '@sfysh/runtime';
import './supplier-portal-daily-pull.js'; // registers the workflow as a side effect

const result = await run('supplier-portal-daily-pull', page);
if (result.status === 'failed') {
  console.error(`${result.error.kind}: ${result.error.message}`);
  process.exit(1);
}
```

The `page` argument comes from your browser backend. In tests, use `@sfysh/playwright-adapter` to bridge a Playwright `Page`.

## Package layout

```
src/
  index.ts        # barrel: public API only
  types.ts        # Page and Locator interfaces
  workflow.ts     # registry (workflow, getWorkflow, listWorkflows)
  runner.ts       # run(), error classification into FailureKind
  assert.ts       # assert, poll, AssertionError
  vault.ts        # resolvers and vault()
  emit.ts         # extraction buffering
  guard.ts        # conditional step execution
test/
  runner.test.ts  # success and all four failure classifications
  vault.test.ts   # resolver swap, missing-secret error
  emit.test.ts    # buffering and schema validation
  guard.test.ts   # conditional execution
```

## Design notes

- **Backend-agnostic by design.** `Page` and `Locator` are structural interfaces, not Playwright types. A Playwright page satisfies them because Playwright is a structural superset; CDP, Puppeteer, or an in-house driver can satisfy them too. See `@sfysh/playwright-adapter` for the Playwright bridge.
- **Secrets never materialise in generated code.** Templates emit `vault('NAME')` calls; the resolver reads from the environment (or a custom source) at run time. Compiled scripts can be committed and reviewed safely.
- **Errors are classified, not just thrown.** The healer triages failures by `FailureKind` without re-executing the script. The runner's classifier is the single source of truth for that mapping; add a new kind here before the healer learns about it.
