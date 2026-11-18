# @sfysh/benchmark

End-to-end benchmark harness for Starfysh. Runs a suite of real-browser tasks, records pass/fail and duration for each, and writes a timestamped JSON report to `results/`.

## Running locally

Install Playwright's Chromium browser once, and again whenever `playwright-core` is upgraded:

```sh
pnpm --filter @sfysh/benchmark exec playwright-core install chromium chromium-headless-shell
```

Use this command and not `npx playwright install`. The repo depends on `playwright-core` only, so `npx playwright` downloads the newest Playwright release, which installs a different browser build from the one the benchmark launches.

Then run the suite from the repo root:

```sh
pnpm --filter @sfysh/benchmark bench
```

Results are written to `benchmark/results/<timestamp>.json`.

## Tasks

| ID                       | Site                 | What it tests                                       |
| ------------------------ | -------------------- | --------------------------------------------------- |
| `books-catalogue`        | books.toscrape.com   | List extraction from a catalogue page               |
| `books-category`         | books.toscrape.com   | Category navigation and item count                  |
| `books-detail`           | books.toscrape.com   | Detail page extraction (title, price, availability) |
| `hacker-news-headlines`  | news.ycombinator.com | Front page headline extraction                      |
| `wikipedia-web-scraping` | en.wikipedia.org     | Article paragraph extraction                        |

All tasks use public sites that require no authentication.

## Synthetic drift

`drift/` reproduces site changes in a controlled way, with a known right answer, to measure the healer. It runs locally with no network: a fixture page is served by Playwright at a fake origin, and a list of DOM edits (a drift) is applied to it on every load.

```sh
pnpm --filter @sfysh/benchmark test:drift
```

That runs the drift self-tests in Chromium (about a minute and a half; the cases run concurrently). They are not part of the repository's `pnpm test`, because the baseline runs without a browser; the nightly benchmark workflow runs them.

**Pieces.**

| File                            | What it is                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fixtures/portal.html`          | A small supplier portal: navigation links, a search field, an Apply button and an orders table.                                                                                                                    |
| `fixtures/portal.workflow.json` | The workflow written against it: open orders, search for ACME, apply, read the table and the heading.                                                                                                              |
| `fixtures/shop.html`            | A small hardware shop: catalogue link, category buttons, product cards, and a delivery postcode form.                                                                                                              |
| `fixtures/shop.workflow.json`   | The workflow written against it: open the catalogue, pick Garden, read the products, check delivery to 2000, read the estimate.                                                                                    |
| `page-drift.js`                 | The operators, run inside the page: `rename_text`, `set_attribute`, `remove_attribute`, `retag`, `reorder_columns`, `wrap_in_menu`, `add_overlay`, `add_decoy`, `remove`, `on_loads`, `shadow`, `iframe`, `delay`. |
| `oracle.ts`                     | Builds a case's correct heal as real patches and checks each against the healer's rules.                                                                                                                           |
| `drift.ts`                      | `loadFixture`, `driftedPages` (a page factory for `replay` and the healer), `observe` (run a workflow and record what it did), `judgeHeal`.                                                                        |
| `cases.ts`                      | The suite: 51 named cases across both fixtures, each with the effect it must have, the step it breaks, the heal that would be right, and whether a decoy trap is present.                                          |

**How a heal is judged.** Not by verification, which only sees outputs. Elements the workflow is meant to act on carry a hidden truth marker, and the fixture records which marked element each click and fill lands on. `judgeHeal(baseline, patched)` calls a heal correct only if the patched workflow on the drifted page acts on the same elements, in the same order, as the original workflow on the clean page, and produces exactly the same outputs with no tolerance. Clicks on elements a drift added (a banner's dismiss button, a menu toggle) are allowed. A decoy that behaves like the real element and yields identical outputs passes verification, and is still judged a false heal. The healer never sees the markers: its view of the page is the accessibility tree.

**The suite.** 69 cases, 38 on the portal and 31 on the shop, in four groups: single changes (one thing renamed, moved or removed), robustness (changes the workflow should survive), silent breakages, and complex changes.

| Effect on the workflow | Cases | What it means                                                                                                                                                                         |
| ---------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fails`                | 42    | The run fails even with selector fallback; the healer is invoked.                                                                                                                     |
| `degrades`             | 11    | The run passes only on fallback selectors; a promotion is offered.                                                                                                                    |
| `none`                 | 11    | The workflow copes: case and substring name matching, reordered columns, restyled elements, icon buttons with an accessible name, shadow DOM, late rendering within an action's wait. |
| `silent`               | 5     | The run passes with different outputs, because an extract read nothing or less, including a list that renders after it is read. No failure, so the healer is never told.              |

The right first heal: `selector` 19, `insert_step` 13 (menus, banners, a wait for a slow element), `promotion` 11, `not_healable` 10, `none` 16. Five cases are decoy traps, including an identical twin button that only its position tells apart.

**Complex changes** test what Starfysh can do when several things change at once: German-language versions of both sites (every label at once, healed by promotions, or by three selector heals when the redesign also drops test ids), full redesigns that need three heals in a row (banner, menu, renamed link), A/B tests and banners that only show on some visits (`on_loads`), elements moved into shadow DOM and into an iframe, and late rendering (`delay`).

**Oracles.** Every healable case carries a correct heal (`oracle`, built in `oracle.ts`), as successive patches when it needs several. The self-tests build each oracle patch as a real `StepPatch`, pass it through the healer's own `checkPatch` for its class, apply it, and require `judgeHeal` to call the result correct. So every case marked healable is provably healable within Starfysh's rules, and a model's heal can be compared with a known right answer.

**Known gaps.** Six `not_healable` cases are things a person could fix but Starfysh cannot yet, marked with `gap`: `ab_test` (2; a patch is verified on its first selector only, so it fails on the other design), `intermittent` (2; an inserted dismiss click fails on visits without the banner), `iframe` (1; the runtime cannot enter frames), `header_alias` (1; the fix is an `x-header` alias, and patches may not change an extract schema). The other four `not_healable` cases remove the feature the workflow needs.

**Adding a case.** Add an entry to `cases.ts` with its drifts and expectation. The self-tests check that it really has the effect it claims; a drift selector that matches nothing fails the case rather than silently doing nothing.

## Adding a task

1. Create `tasks/<your-id>/task.yml` with id, name, url, description, and output schema.
2. Create `tasks/<your-id>/workflow.ts` that calls `workflow('<your-id>', async (page) => { ... })` and uses `emit.output()` for results.
3. Add an import line for the new module in `harness/index.ts`.

## Output format

Each run writes a report like:

```json
{
  "timestamp": "2026-10-25T10:00:00.000Z",
  "durationMs": 12430,
  "taskCount": 5,
  "passed": 5,
  "failed": 0,
  "tasks": [...]
}
```
