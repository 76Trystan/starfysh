# @sfysh/parser

Parser that reads hand-written Playwright TypeScript scripts and lifts them into the Starfysh IR. Once a Playwright script is in IR form, the Starfysh verifier can replay it, the healer can patch broken steps, and the compiler can regenerate deterministic TypeScript.

## Status

Scaffolded, not yet implemented. The package is private (`"private": true` in `package.json`) and will stay that way until the walker, selector extraction, and pre/post inference pass their tests. Follow the Phase 1 checklist in `docs/planning/ToDo.md` for the current state.

Importing `parse()` today throws `ParserNotImplementedError`. The signature is stable so downstream packages (the CLI, the verifier) can be written against it ahead of the implementation.

## What it will do

Given a Playwright script like:

```ts
import { test, expect } from '@playwright/test';

test('submit a report', async ({ page }) => {
  await page.goto('https://portal.example.com/reports/new');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText('Submitted')).toBeVisible();
});
```

`parse(source)` will return a `Workflow` matching `@sfysh/ir`'s schema, with:

- One step per Playwright action (`page.goto`, `click`, `fill`, `waitFor`, etc.)
- Ranked selector candidates per step (role based first, then test-id, then CSS)
- `pre` and `post` conditions inferred from `expect()` calls that surround each action
- Values that look like test inputs lifted to typed parameters
- Credentials replaced with vault references rather than left as literals

The output must validate against `@sfysh/ir`'s schema and must survive a round-trip through `@sfysh/compiler` back to deterministic TypeScript.

## Installation

Not yet published. Use the workspace symlink.

```sh
pnpm add @sfysh/parser@workspace:*
```

## Dependencies

- `@sfysh/ir` for the output type
- `ts-morph` (added when the walker lands)
