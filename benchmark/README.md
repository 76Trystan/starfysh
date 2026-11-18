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

That runs the drift self-tests in Chromium. They are not part of the repository's `pnpm test`, because the baseline runs without a browser; the nightly benchmark workflow runs them.

**Pieces.**

| File                            | What it is                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixtures/portal.html`          | A small supplier portal: navigation links, a search field, an Apply button and an orders table.                                                                           |
| `fixtures/portal.workflow.json` | The workflow written against it: open orders, search for ACME, apply, read the table and the heading.                                                                     |
| `page-drift.js`                 | The operators, run inside the page: `rename_text`, `set_attribute`, `remove_attribute`, `retag`, `reorder_columns`, `wrap_in_menu`, `add_overlay`, `add_decoy`, `remove`. |
| `drift.ts`                      | `loadFixture`, `driftedPages` (a page factory for `replay` and the healer), `observe` (run a workflow and record what it did), `judgeHeal`.                               |
| `cases.ts`                      | Named cases, each with the effect it must have (`fails`, `degrades`, `none`), the step it breaks, and the heal that would be right.                                       |

**How a heal is judged.** Not by verification, which only sees outputs. Elements the workflow is meant to act on carry a hidden truth marker, and the fixture records which marked element each click and fill lands on. `judgeHeal(baseline, patched)` calls a heal correct only if the patched workflow on the drifted page acts on the same elements, in the same order, as the original workflow on the clean page, and produces exactly the same outputs with no tolerance. Clicks on elements a drift added (a banner's dismiss button, a menu toggle) are allowed. A decoy that behaves like the real element and yields identical outputs passes verification, and is still judged a false heal. The healer never sees the markers: its view of the page is the accessibility tree.

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
