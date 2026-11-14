# @sfysh/parser

## 0.3.0

### Minor Changes

- 656cb8e: Emit IR `extract` steps for Playwright data-read patterns.

  The parser now lifts four locator terminal methods into `extract` IR steps with weak default schemas:

  | Playwright call             | IR schema                                      |
  | --------------------------- | ---------------------------------------------- |
  | `locator.textContent()`     | `{ type: 'string' }`                           |
  | `locator.innerText()`       | `{ type: 'string' }`                           |
  | `locator.inputValue()`      | `{ type: 'string' }`                           |
  | `locator.allTextContents()` | `{ type: 'array', items: { type: 'string' } }` |

  When the call is the initializer of a `const`/`let`/`var` single-declaration statement (e.g. `const name = await page.getByTestId('user').textContent()`), the variable name is captured as the step's `bind` field so later steps and workflow outputs can reference it. Destructuring patterns and multi-declaration statements are skipped for v1.

  `locator.evaluate()` is intentionally not supported and surfaces through the existing unsupported-call list, consistent with "page content never reaches arbitrary code".

  Column-type inference for `allTextContents` (and table iteration via `for (const row of await locator('tr').all())`) are tracked as follow-up ToDo items. The parser-emitted schemas are the loosest JSON Schema shape that still gates the verifier's output-stability comparison.

## 0.2.0

### Minor Changes

- e2963cc: Surface unsupported Playwright methods instead of dropping them silently.

  Breaking: `parse(source)` now returns `{ workflow, unsupported: UnsupportedCall[] }` rather than a bare `Workflow`. Any `page.<method>()` call whose terminal method is outside the parser's supported set (`goto`, `click`, `fill`, `waitForTimeout`, `waitForSelector`, `waitForURL`) is collected into `unsupported` with its method name, 1-based source position, and the raw call text. Callers should surface the list so users know which actions were dropped from the workflow.

  Migration:

  ```ts
  // before
  const workflow = parse(source);

  // after
  const { workflow, unsupported } = parse(source);
  if (unsupported.length > 0) {
    // warn the user, e.g. CLI prints the list to stderr
  }
  ```

  `CallChain` from the walker also grew a `text: string` field (the await-stripped raw source of the call expression), which the unsupported-call reporter uses to quote user source verbatim.

## 0.1.0

### Minor Changes

- 33f0555: Initial public release. `@sfysh/parser` lifts hand-written Playwright TypeScript scripts into the Starfysh IR so existing scripts can be verified and healed by the Starfysh toolchain. Covers `page.goto`, `fill`, `click`, `waitFor*`, ranked selector extraction from `getByRole` / `getByTestId` / `getByText` / `getByLabel` / CSS locators, and condition inference from `expect().toBeVisible()`, `.toHaveURL()`, `.toHaveText()`, and related matchers.
