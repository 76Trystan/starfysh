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

`wrapWorkflowForTest` registers a Playwright test that runs the named workflow against Playwright's `page` fixture. If the workflow fails, the test fails with the original error.

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

Casts a Playwright `Page` to Starfysh's `Page` interface. Safe at runtime because Playwright's `Page` is a structural superset of Starfysh's.

### `asLocator(locator: PlaywrightLocator): Locator`

Same as `asPage` but for `Locator`.

### `wrapWorkflowForTest(test, workflowId, options?)`

Registers a named Starfysh workflow as a Playwright test.

| Parameter       | Type               | Description                                    |
| --------------- | ------------------ | ---------------------------------------------- |
| `test`          | `PlaywrightTestFn` | The `test` object from `@playwright/test`      |
| `workflowId`    | `string`           | ID of a registered workflow                    |
| `options.title` | `string`           | Optional test title (defaults to `workflowId`) |
