# @sfysh/parser

Parser that reads hand-written Playwright TypeScript scripts and lifts them into the Starfysh IR. Once a Playwright script is in IR form, the Starfysh verifier can replay it, the healer can patch broken steps, and the compiler can regenerate deterministic TypeScript.

## Usage

```ts
import { parse } from '@sfysh/parser';

const { workflow, unsupported, warnings } = parse(source);
```

Given a Playwright script like:

```ts
import { test, expect } from '@playwright/test';

test('submit a report', async ({ page }) => {
  await page.goto('https://portal.example.com/reports/new');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText('Submitted')).toBeVisible();
});
```

`parse(source)` returns a `ParseResult`:

- `workflow` is a `Workflow` that validates against `@sfysh/ir`'s schema, built from the first `test()` call in the source. Each recognised Playwright action becomes one IR step with ranked selector candidates (role based first, then test-id, then CSS), and recognised `expect()` assertions become postconditions on the preceding step (or standalone assert steps when nothing precedes them).
- `unsupported` lists every call the parser recognised syntactically but could not map into the IR, so nothing is dropped silently. Two shapes land here: `page.<method>()` chains whose terminal method is outside the supported set (for example `hover` or `screenshot`), and `expect()` chains whose matcher, subject, or argument could not be translated (for example `toHaveCount`, or `toHaveURL` with a regex argument). Each entry carries the terminal `method` name, the 1-based source `position`, and the raw call `text`.

- `warnings` lists literal values the author should review. A literal typed into a field that looks like a credential (a label or selector containing `password`, `token`, `secret`, `otp`, `pin`, `api key` and similar) is never copied into the IR. The parser replaces it with a vault reference such as `{ secret: 'password' }`, declares the name in `workflow.secrets`, and adds a `literal-secret` warning. You then supply the value through the vault at run time. Every other literal `fill` value is kept and reported as a `literal-fill` warning, in case the field is sensitive and the parser did not recognise it. Warnings carry the step id and source position, never the literal value.

`parse` throws `ParseError` when the source contains no `test()` calls or no recognisable actions at all.

## What is recognised today

- **Actions:** `page.goto`, `click`, `fill`, `waitForTimeout`, `waitForSelector`, `waitForURL`.
- **Data reads:** locator terminals `textContent`, `innerText`, `inputValue`, and `allTextContents` become IR `extract` steps with weak default schemas. A single-declaration binding such as `const name = await page.getByTestId('user').textContent()` carries `bind: 'name'` onto the step.
- **Assertions:** `toHaveURL`, `toBeVisible`, `toBeHidden`, `toContainText`, `toHaveText` with string arguments and subjects built from `getByText`, `getByLabel`, `getByTestId`, `getByRole`, or `locator`.
- **Selectors:** `getByRole`, `getByTestId`, `getByText`, `getByLabel`, and CSS `locator` chains, ranked per the IR's candidate ordering.

Table iteration (`for (const row of await locator.all())`) and richer extract schema inference are tracked in the Phase 1 checklist and not yet supported.

## Installation

```sh
pnpm add @sfysh/parser
```

## Dependencies

- `@sfysh/ir` for the output type
- `ts-morph` for the TypeScript AST walk
