---
'@sfysh/parser': minor
---

Emit IR `extract` steps for Playwright data-read patterns.

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
