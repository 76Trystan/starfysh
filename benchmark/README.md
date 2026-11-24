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

| File                            | What it is                                                                                                                                                                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixtures/portal.html`          | A small supplier portal: navigation links, a search field, an Apply button and an orders table.                                                                                                                                                                                                    |
| `fixtures/portal.workflow.json` | The workflow written against it: open orders, search for ACME, apply, read the table and the heading.                                                                                                                                                                                              |
| `fixtures/shop.html`            | A small hardware shop: catalogue link, category buttons, product cards, and a delivery postcode form.                                                                                                                                                                                              |
| `fixtures/shop.workflow.json`   | The workflow written against it: open the catalogue, pick Garden, read the products, check delivery to 2000, read the estimate.                                                                                                                                                                    |
| `fixtures/bank.html`            | An online banking portal, written for the held-out set and not part of v1: a statements link, an account choice between look-alike buttons (Everyday and Savings), From and To date fields, a transactions table with a signed amount column, and a closing balance computed from what was chosen. |
| `fixtures/bank.workflow.json`   | The workflow written against it: open statements, choose the everyday account, enter 1 to 31 October 2026, show the transactions, read the table and the closing balance.                                                                                                                          |
| `page-drift.js`                 | The operators, run inside the page: `rename_text`, `set_attribute`, `remove_attribute`, `retag`, `reorder_columns`, `wrap_in_menu`, `add_overlay`, `add_decoy`, `remove`, `on_loads`, `shadow`, `iframe`, `delay`.                                                                                 |
| `oracle.ts`                     | Builds a case's correct heal as real patches and checks each against the healer's rules.                                                                                                                                                                                                           |
| `drift.ts`                      | `loadFixture`, `driftedPages` (a page factory for `replay` and the healer), `observe` (run a workflow and record what it did), `judgeHeal`, `judgeProgress` (one heal of several), `namesTruthMarker`.                                                                                             |
| `heal-run.ts`                   | `runDriftCase`: runs the healer on one case until it passes or the healer stops, judges every heal, and writes the corpus.                                                                                                                                                                         |
| `run.ts`, `summary.ts`          | The `heal:drift` command and its printed summary.                                                                                                                                                                                                                                                  |
| `report.ts`, `report-cli.ts`    | The `report:drift` command: the published report (group split, Wilson intervals, refusals, gaps, cost, score bands) built from `results.json`.                                                                                                                                                     |
| `oracle-provider.ts`            | A provider that answers with each case's oracle heal, for a free dry run of the harness.                                                                                                                                                                                                           |
| `cases.ts`                      | The suite: 69 named cases across both fixtures, each with its group, the effect it must have, the step it breaks, the heal that would be right, and whether a decoy trap is present.                                                                                                               |
| `cases-h1.ts`                   | Held-out set h1: 42 cases on the bank fixture, written for the published headline and never tuned against. Runs only with the oracle provider until it is frozen in `suites.ts`.                                                                                                                   |
| `suites.ts`                     | The frozen suites a published number may name, each with its role (`tuning` or `held_out`) and the sha256 of its cases and fixture files. `suites.unit.test.ts` fails if a frozen file changes.                                                                                                    |
| `case-sets.ts`                  | The case sets `heal:drift --cases` can run, and the rule that a set meant to be held out meets no model before it is frozen.                                                                                                                                                                       |
| `case-kit.ts`                   | The fixture type and case-writing helpers for case sets after v1. `cases.ts` is frozen, so its narrower type and its helpers are copied here rather than edited.                                                                                                                                   |

**How a heal is judged.** Not by verification, which only sees outputs. Elements the workflow is meant to act on carry a hidden truth marker, and the fixture records which marked element each click and fill lands on. `judgeHeal(baseline, patched)` calls a heal correct only if the patched workflow on the drifted page acts on the same elements, in the same order, as the original workflow on the clean page, and produces exactly the same outputs with no tolerance. Clicks on elements a drift added (a banner's dismiss button, a menu toggle) are allowed. A decoy that behaves like the real element and yields identical outputs passes verification, and is still judged a false heal. The healer never sees the markers: its view of the page is the accessibility tree.

**The suite.** 69 cases, 38 on the portal and 31 on the shop, in four groups: single changes (one thing renamed, moved or removed), robustness (changes the workflow should survive), silent breakages, and complex changes.

**Frozen versions.** The 69 cases above were frozen as `drift-suite v1` on 2026-11-22 (`suites.ts`). v1 is the tuning set: the healer's prompt was changed on 2026-11-20 because of what these cases showed, so its rates are partly fitted to them. A published headline comes from a held-out suite that no prompt or scorer change is ever tuned against, with v1 reported beside it under its label. A frozen suite's cases and fixtures never change; new or changed cases go into the next version, and a prompt change after a held-out suite exists means a new held-out suite. Each frozen suite also records a hash of the cases its file builds (as canonical JSON), so a change to a shared case helper in `case-kit.ts` that alters a frozen suite's cases fails `suites.unit.test.ts` even though no frozen file changed. The drift operators and the healer are not frozen, since they are the code under test.

**Held-out set h1.** 42 cases on the bank fixture (`cases-h1.ts`, written 2026-11-23): 28 healable (13 `selector`, 8 `promotion`, 7 `insert_step`), 8 `not_healable` (one per gap, plus four removals), 5 robustness and 1 silent. Four are decoy traps. It is shaped to differ from v1 rather than repeat it: the look-alikes are part of the page (two account buttons, two date fields whose labels differ by one word), two decoys are semantic rather than textual ('Account activity' beside a renamed Statements link, 'Main account' beside a renamed Everyday account), one field loses its label and keeps only a test id and a placeholder it shares with its neighbour, and one refusal case has a tempting wrong answer (the Everyday account is removed, and the Savings button still works). Column reordering is left out, because the fixture's own script reads cells by position. The oracle dry run heals all 28 healable cases correctly, refuses all 8 not-healable ones, and keeps the 6 others away from the healer. The set is registered in `case-sets.ts` as `held_out`, so `heal:drift` refuses any model on it until it is frozen in `suites.ts`.

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

**Running the healer on the suite.**

```sh
pnpm --filter @sfysh/benchmark heal:drift -- --provider anthropic --model <id> --price-in <usd> --price-out <usd> --max-usd 5
pnpm --filter @sfysh/benchmark heal:drift -- --provider oracle   # free dry run
```

Each case runs the way a user's workflow would meet the change. A run that passes on a fallback selector gets a promotion (no model); a failure goes to `heal()`. A decided patch is applied as if a reviewer approved it, and the workflow runs again, up to four heals, because some cases need several. Each heal is written to a corpus with a `benchmark` label from the judge, and the final workflow is judged on page loads 1 and 2, so an A/B test or an intermittent banner shows both faces. A patch that names the truth marker is scored a false heal: the model cannot see it, so it was invented. Model calls go through a `MeteredProvider`, so tokens and cost are recorded per case when prices are given.

Options: `--runs <n>` (default 1; use 3 or more for anything published, since model answers vary), `--cases <set>` (which case set to run, default `v1`; listed in `case-sets.ts`, and a set meant to be held out runs only with `--provider oracle` until it is frozen in `suites.ts`), `--case <id-prefix>` (repeatable), `--group <single|robustness|silent|complex>`, `--max-tokens`, `--out <dir>`. Results go to `results/drift-<timestamp>/`: `results.json` (a header with the case set, its cases file and that file's hash, provider, model, prices and the judge's definition, then one entry per case run) and `corpus/heals.jsonl`, which `compile report --dir <that directory>` reads. The printed summary is a working view, not the published report.

**The report.** `report:drift` builds the published report from a results folder and writes `report.md` and `report.json` into it:

```sh
pnpm --filter @sfysh/benchmark report:drift -- results/drift-<timestamp> --suite-version "drift-suite v1"
```

Its format was fixed before any real numbers existed, so it could not be chosen to flatter a result. The unit is a case run. The false-heal rate is case runs with at least one false heal over case runs with a verified, decided patch, and the heal rate is correct runs over all runs, so healing nothing cannot score well. Every rate has a 95% Wilson interval. Results are split into single changes, complex changes and decoy traps (always shown), with a refusals table for the `not_healable` cases that names every gap, a count of the cases that should never reach the healer (kept out of every rate), oracle agreement, cost per run and per correct heal, and false heals by confidence score. A one-sentence headline is printed only when nothing rules it out: the report lists why at the top when the run is a dry run, covers part of the suite, names no frozen suite or one whose `cases.ts` hash differs from the results', is on the tuning set, has fewer than 3 runs per case, or has unpriced calls. Without `--suite-version` the suite is found from the hash in `results.json`.

The oracle dry run is the harness's own check: every single-change case heals correctly, every not-healable case gets no patch, and no case meant to pass reaches the healer. Seven of the eight healable complex cases heal correctly; the redesigns and locale switches go through partial heals, one step at a time, and the identical twin is triaged as an ambiguous selector. The one that does not is the portal's full redesign: it needs three heals on the same link (a banner, then a menu, then the rename), and after the first the run fails at that link exactly as before, which verification cannot tell from a click that did nothing.

**Adding a case.** Frozen cases files (`cases.ts`, and any set listed in `suites.ts`) do not change, so a new case goes into the next set's cases file, written with the helpers in `case-kit.ts` and listed in `CASE_SETS`. The self-tests check that it really has the effect it claims; a drift selector that matches nothing fails the case rather than silently doing nothing.

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
