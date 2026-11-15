# @sfysh/playwright-adapter

Bridges Playwright's `Page` and `Locator` types to Starfysh's runtime interfaces. Teams with existing Playwright infrastructure can run Starfysh workflows inside their Playwright test suite without rewriting anything.

## Installation

```sh
pnpm add @sfysh/playwright-adapter @sfysh/runtime
```

`playwright-core` is a peer dependency - install it alongside if you don't already have it.

## Usage

### Running a workflow inside a Playwright test

```ts
import { test } from '@playwright/test';
import { wrapWorkflowForTest } from '@sfysh/playwright-adapter';
import './workflows/my-workflow.js'; // registers the workflow as a side effect

wrapWorkflowForTest(test, 'my-workflow');
```

`wrapWorkflowForTest` registers a Playwright test that runs the named workflow against Playwright's `page` fixture. If the workflow fails, the test fails with an error that keeps the original name, message, and stack, with any vault secrets replaced by `[REDACTED:<name>]`. The raw error is not re-thrown, because Playwright quotes filled values in its call log and that text would otherwise reach the test reporter and CI logs.

You can override the test title:

```ts
wrapWorkflowForTest(test, 'my-workflow', { title: 'Checkout flow completes successfully' });
```

### Using a Playwright page directly

If you need finer control, cast the page manually with `asPage`:

```ts
import { test } from '@playwright/test';
import { asPage } from '@sfysh/playwright-adapter';
import { run } from '@sfysh/runtime';
import './workflows/my-workflow.js';

test('my workflow', async ({ page }) => {
  const result = await run('my-workflow', asPage(page));
  if (result.status === 'failed') throw new Error(result.error?.message);
});
```

### Migrating existing Playwright scripts

If you have existing Playwright scripts you want to run through the Starfysh healer and verifier, wrap them in a `workflow()` call and use `asPage` to bridge the types:

```ts
import { workflow } from '@sfysh/runtime';
import { asPage } from '@sfysh/playwright-adapter';
import type { Page } from 'playwright-core';

// Your existing Playwright logic, unchanged
async function myExistingScript(page: Page) {
  await page.goto('https://example.com');
  // ...
}

// Register it as a Starfysh workflow
workflow('my-existing-script', (sfPage) => myExistingScript(sfPage as unknown as Page));
```

## API

### `asPage(page: PlaywrightPage): Page`

Presents a Playwright `Page` as Starfysh's `Page` interface. The result is a thin proxy: every method and property is forwarded to the real Playwright page, so it still works anywhere a Playwright page does.

The proxy adds one method, `snapshot()`, which returns the accessibility tree of the document body as text (Playwright's ARIA snapshot). The runtime calls it after a failed run and attaches the result to `RunResult.snapshot`, so a failure report records what the page looked like. Secrets resolved through the vault are redacted from it and its length is capped.

Two things to know. `asPage(page) === page` is `false`, because the proxy is a different object; calling `asPage` twice with the same page returns the same proxy. And a page that already has a `snapshot` method is returned unchanged.

### `asLocator(locator: PlaywrightLocator): Locator`

Casts a Playwright `Locator` to Starfysh's `Locator` interface. Safe at runtime because Playwright's `Locator` is a structural superset of Starfysh's.

### `wrapWorkflowForTest(test, workflowId, options?)`

Registers a named Starfysh workflow as a Playwright test.

| Parameter       | Type               | Description                                    |
| --------------- | ------------------ | ---------------------------------------------- |
| `test`          | `PlaywrightTestFn` | The `test` object from `@playwright/test`      |
| `workflowId`    | `string`           | ID of a registered workflow                    |
| `options.title` | `string`           | Optional test title (defaults to `workflowId`) |
