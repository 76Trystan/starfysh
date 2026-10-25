# @asc/benchmark

End-to-end benchmark harness for Starfysh. Runs a suite of real-browser tasks, records pass/fail and duration for each, and writes a timestamped JSON report to `results/`.

## Running locally

Install Playwright's Chromium browser once:

```sh
npx playwright install chromium
```

Then run the suite from the repo root:

```sh
pnpm --filter @asc/benchmark bench
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
