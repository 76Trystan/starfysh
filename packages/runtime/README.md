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

Failure classification lives in `@sfysh/triage`, not here. `RunResult.error` carries the raw `{ message, cause, stepId?, phase? }` shape; callers pass it to `triage.classify()` to decide a `FailureKind`.

### Assertions and polling

| Export              | Purpose                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `assert(cond, msg)` | Throws `AssertionError` with the given message if the condition is false. Used by step pre/postconditions. |
| `poll(fn, opts)`    | Polls until `fn` returns a truthy value or the timeout fires. Returns the value.                           |
| `AssertionError`    | Thrown by `assert`. `@sfysh/triage` classifies it as a `site` failure.                                     |

### Control flow

Generated code and the verifier's IR interpreter both call these, so a loop cap, a step deadline or a flow condition behaves the same way whichever one runs the workflow.

| Export                                           | Purpose                                                                                                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `step(ctx, info, body, { timeoutMs })`           | Runs one IR step and attributes any failure to it. With `timeoutMs` above zero, the step fails with `StepTimeoutError` if it runs longer.                      |
| `conditionHolds(page, condition, stepId)`        | Evaluates a guard, wait, assert or loop condition with the same evaluator as pre and post checks. Throws `UnsupportedConditionError` for one it cannot answer. |
| `forEachItem(stepId, max, items, body)`          | Runs `body(item)` for each item, failing with `LoopLimitError` on the iteration after `max`.                                                                   |
| `whileHolds(page, stepId, condition, max, body)` | Runs `body()` while the condition holds, failing with `LoopLimitError` on the iteration after `max`.                                                           |
| `withTimeout(stepId, timeoutMs, body)`           | The deadline `step()` uses, for code that needs one outside a step.                                                                                            |
| `DEFAULT_MAX_ITERATIONS`                         | 100, the IR schema's default for `maxIterations`.                                                                                                              |

**`foreach` bodies are scoped to the item.** Inside a `foreach` loop, generated code looks every target up within the current item (`item.getByRole(...)`, `item.locator(...)`), not across the page. That is why `Locator` has `getByRole`, `getByTestId`, `getByText` and `getByLabel`, as `Page` does. Conditions are still read from the page, also inside a loop: a guard's `selectorVisible` checks the whole page, while the click inside it acts within the item.

A timeout cannot cancel the work it gives up on, so a step that timed out may still be acting on the page. The run has failed by then; close the page.

### Secrets

| Export                       | Purpose                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `vault(name)`                | Resolves a secret by name through the active resolver. Generated code uses this; literal secrets never ship.       |
| `setVaultResolver(r)`        | Swaps the active resolver. Call once at startup if you are not using the default.                                  |
| `EnvVaultResolver`           | Default resolver. Reads `SFYSH_SECRET_<NAME>` from the environment. Takes `prefix` and `allow` options.            |
| `VaultSecretNotAllowedError` | Thrown when a secret is not on the resolver's `allow` list. Not a missing credential, so it is not treated as one. |
| `VaultResolver`              | Interface for custom resolvers (`{ resolve(name): string \| undefined }`).                                         |
| `VaultSecretMissingError`    | Thrown when a secret cannot be resolved. `@sfysh/triage` classifies it as an `auth` failure.                       |

#### Where the default resolver looks

`vault('supplier_password')` reads the environment variable `SFYSH_SECRET_SUPPLIER_PASSWORD`: the prefix, then the name in upper case. The prefix is there so that a workflow definition cannot name an unrelated variable, such as `aws_secret_access_key`, and type it into a page. A workflow can only reach what an operator put under the prefix.

```ts
import { EnvVaultResolver } from '@sfysh/runtime';

new EnvVaultResolver(); // SFYSH_SECRET_<NAME>, with the deprecated fallback below
new EnvVaultResolver({ prefix: 'ACME_' }); // ACME_<NAME> only
new EnvVaultResolver({ allow: ['supplier_password'] }); // any other name throws
```

**Deprecated fallback.** Earlier versions read the unprefixed variable (`SUPPLIER_PASSWORD`). With no `prefix` option, the resolver still falls back to it when the prefixed variable is not set, and emits a `DeprecationWarning` (code `SFYSH_UNPREFIXED_SECRET`) once per secret name. The fallback will be removed in a later release. Setting `prefix`, even to the default `SFYSH_SECRET_`, turns it off now. Pass `prefix: ''` if you want unprefixed variables on purpose.

**Allowlist.** `allow` limits the resolver to a list of secret names, compared exactly. Any other name throws `VaultSecretNotAllowedError` whether or not the variable is set. `@sfysh/verifier` passes the workflow's declared `secrets` here by default.

### Extraction

| Export            | Purpose                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `emit(row)`       | Buffers a row for later flush. Generated extraction steps call this.                                         |
| `flushOutputs()`  | Returns the buffered rows and clears the buffer. Call this at workflow end.                                  |
| `drainOutputs()`  | Alias used by some adapters.                                                                                 |
| `ExtractionError` | Thrown when an extracted value fails its declared schema. `@sfysh/triage` classifies it as a `site` failure. |
| `ColumnSchema`    | Row-column type union.                                                                                       |
| `TableRow`        | Shape of a buffered row.                                                                                     |

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
  console.error(result.error.message);
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
  runner.ts       # run() executor; raw error shape only, classification lives in @sfysh/triage
  assert.ts       # assert, poll, AssertionError
  vault.ts        # resolvers and vault()
  emit.ts         # extraction buffering
  guard.ts        # conditional step execution
test/
  runner.test.ts  # success, failure attribution, secret redaction
  vault.test.ts   # resolver swap, missing-secret error
  emit.test.ts    # buffering and schema validation
  guard.test.ts   # conditional execution
```

## Design notes

- **Backend-agnostic by design.** `Page` and `Locator` are structural interfaces, not Playwright types. A Playwright page satisfies them because Playwright is a structural superset; CDP, Puppeteer, or an in-house driver can satisfy them too. See `@sfysh/playwright-adapter` for the Playwright bridge.
- **Secrets never materialise in generated code.** Templates emit `vault('NAME')` calls; the resolver reads from `SFYSH_SECRET_` variables in the environment (or a custom source) at run time. Compiled scripts can be committed and reviewed safely.
- **Errors are reported, not classified here.** The runner returns the raw error shape (`message`, `cause`, `stepId?`, `phase?`). Triage lives in `@sfysh/triage` so classification rules can stay surface-agnostic and extend to the HTTP surface in Phase 2 without touching the runtime.
