# False-heal rate: methodology

When a workflow breaks because a site changed, the Starfysh healer proposes a patch to the failed step. Most of the time the question people ask is whether it fixed the workflow. The more important question is whether the fix is right. A patch can pass every check Starfysh runs and still act on the wrong element: it clicks an archived supplier that looks like the real one, or reads a column that happens to hold numbers of the same shape. That is a **false heal**, and it is worse than no heal at all, because the workflow keeps running and quietly produces wrong results.

This page describes how Starfysh measures its false-heal rate: what a test case is, how a heal is judged, which figures are reported and how they are calculated, and what the method cannot tell you. It is written so that anyone can rerun the benchmark and check the numbers. The harness itself, and the commands that run it, are documented in [`benchmark/README.md`](../../benchmark/README.md).

---

## Why this needs its own measurement

Starfysh verifies every patch before offering it: the patched workflow is replayed against the live page several times, and each run must pass its postconditions and produce stable outputs. Verification is necessary, but it only sees outputs. If a decoy element behaves like the real one and yields the same outputs, verification passes and has no way to know anything went wrong.

So a false-heal rate cannot be measured on real sites, where nobody knows the right answer. It needs site changes whose correct fix is known in advance. That is what the synthetic drift benchmark provides.

## The test bed

**Fixture sites.** Each fixture is a small, self-contained web page served locally by Playwright at a fake origin, with no network access: a supplier portal, a hardware shop, an online banking portal and a purchase order portal. Each has a workflow written against it, of about eight steps (clicks, fills and extracts), whose outputs depend on what it chose. Choosing the wrong account, supplier or date field changes the outputs, rather than only an internal marker.

**Drift cases.** A case is a list of DOM edits applied to a fixture on every page load: rename a link, drop a test id, move a button into a menu, add a cookie banner, insert a look-alike element, reorder table columns, and so on. Each case records:

- the effect it must have on the unmodified workflow (`fails`, `degrades`, `none` or `silent`, explained below);
- the step it breaks;
- the right first response from the healer (a patch class, or no patch);
- the correct heal itself, called the oracle, built as real patches;
- whether a decoy trap is present.

**Self-tests.** Before any model is run, the harness checks every case in a real browser. Each case must have exactly the effect it claims. Each oracle patch is passed through the healer's own patch rules, applied, and judged correct. So every case marked healable is provably healable within Starfysh's rules, and a model's patch can be compared with a known right answer. The self-tests run nightly and on every pull request that could change what a case does.

## How a heal is judged

Verification decides whether a patch is offered. A separate judge decides whether it was right, using information the healer never has.

Each element the workflow is meant to act on carries a hidden truth marker, and the fixture records which marked element each click and fill lands on. A heal is **correct** only if the patched workflow, on page loads 1 and 2 of the drifted fixture:

1. acts on the same marked elements, in the same order, as the original workflow on the clean page;
2. touches no decoy and no unmarked element (clicks on elements the drift itself added, such as a banner's dismiss button or a menu toggle, are allowed);
3. produces exactly the same outputs, with no tolerance.

Anything else that passed verification is a **false heal**. Two page loads are judged so that a change appearing only on some visits shows both faces.

The healer sees the page only as an accessibility tree. It never sees the truth markers. A patch that names a marker anyway is scored a false heal, since the model cannot have seen it and must have invented it.

## What the healer is allowed to do

The healer runs the way it would for a user, with one change that makes the benchmark harsher than real use.

- **Triage first, without a model.** A failure is classified before any model is called. Flakes are retried, expired sessions are sent back to login, and failures that fit no class go to a person. A site change wakes the healer.
- **Degraded selectors are promoted without a model.** If a step passes only on a fallback selector, the healer offers to promote that selector to first place (a `promotion`). No model is involved.
- **Model patches are limited to two classes:** replace the failed step's selectors (`selector`), or insert a step before it, such as a dismiss click or a wait (`insert_step`). The model may also answer that it cannot heal the step, and a patch outside these rules is rejected before it is verified.
- **Every decided patch is applied as if a reviewer approved it.** In real use a person reviews each model-written patch before it runs. The benchmark removes that reviewer, so every patch that passes verification counts, and a false heal is never caught by a person.
- **Up to four heals per case run.** Some cases need several heals in a row (a banner, then a menu, then a renamed link). After each heal the workflow runs again, until it passes or the healer stops.

## Case groups

Not every case should be healed, and the figures are split accordingly.

| Group | What it tests | Counted in |
| --- | --- | --- |
| Single changes | One thing renamed, moved, retagged or removed. | Heal quality |
| Complex changes | Several things at once: a language switch that changes every label, a full redesign needing several heals, late rendering. | Heal quality |
| Decoy traps | A look-alike element sits next to the real one, so a guess can pass verification and still be wrong. These overlap the two groups above and are always shown on their own row. | Heal quality |
| Not healable | The feature the workflow needs is gone, or the fix is outside what Starfysh can do today. The right answer is no patch. | Refusals |
| Never reached | Changes the workflow should survive (`none`), and silent breakages that pass with different outputs (`silent`). The healer is never invoked. | Counts only |

The effects named above mean:

- `fails`: the run fails even with selector fallback, and the healer is invoked;
- `degrades`: the run passes only on fallback selectors, and a promotion is offered;
- `none`: the workflow copes unaided;
- `silent`: the run passes with different outputs, so nothing tells the healer. Starfysh does not yet detect these, and they are reported so that the gap is visible.

**Named gaps.** Some not-healable cases are changes a person could fix but Starfysh cannot yet. They are listed by name in every report so readers can see what Starfysh cannot do: `ab_test` (the site alternates between two designs), `intermittent` (a banner that appears on some visits only), `iframe` (the element moves into a frame) and `header_alias` (a table header is renamed, and the fix would change the extract's schema).

## The figures and how they are calculated

**The unit is a case run:** one case, run once, healed until it passes or the healer stops. Each case is run at least three times, because model answers vary between calls.

- **False-heal rate** = case runs with at least one false heal, divided by case runs with at least one verified, decided patch.
- **Heal rate** = case runs that ended healed and were judged correct, divided by all runs of healable cases. This is reported beside the false-heal rate because a healer that refuses everything would otherwise score a perfect false-heal rate.
- **Refusals** = runs of not-healable cases where the healer correctly produced no patch. A patch produced on a not-healable case is a false heal of the most serious kind, and is listed individually.
- **Oracle agreement** = decided heals that chose the same patch class and the same element as the oracle.
- **Cost** = model tokens and dollars per case run, as median and 90th percentile, and cost per correct heal.
- **Confidence bands** = decided heals grouped by the healer's own confidence score, against the judge's verdict. This shows whether a high score can be trusted.

Every rate carries its denominator and a 95% Wilson score interval. The Wilson interval is used because the counts are small and the rates sit near 0% and 100%, where a simple normal approximation gives intervals that cross the bounds or shrink to nothing.

**Runs of one case are not independent.** Three runs of the same case share the same page, the same change and the same prompt, so their outcomes are correlated. An interval over case runs therefore looks more precise than the evidence is. Alongside each per-run false-heal rate, the results also give the per-case figure: cases with a false heal in any run, divided by cases with a verified patch in any run. The true precision lies between the two. For example, 0 false heals in 75 verified runs gives a Wilson upper bound of about 4.9%, but if those runs came from 25 cases, 0 false heals in 25 gives about 13.3%.

## Tuning set and held-out sets

The healer's prompt was adjusted during development, by looking at what went wrong on the first suite. Any rate measured on those cases is partly fitted to them. Starfysh therefore keeps two kinds of suite:

- **The tuning set** (`drift-suite v1`, 69 cases on the portal and shop fixtures). Prompt and scorer changes may be made because of it. Its results are always reported, and always labelled as the tuning set.
- **Held-out sets** (`drift-suite h1`, 42 cases on the banking portal; `drift-suite h2`, 52 cases on the purchase order portal). Each was written on a fixture site the healer had never been tuned on and frozen before any model ran on it. No prompt, scorer or model choice is ever made by looking at a held-out result. The published headline comes from a held-out set of at least 50 cases, which is h2. h1 is reported beside it as a second held-out result, on a different site.

**What frozen means.** Each frozen suite records the sha256 of its case file, of its fixture files, and of the cases those files build. A test fails if any of them changes. A frozen suite is never edited; corrections and new cases go into the next set. The drift operators and the healer are deliberately not frozen, since they are the code under test, and the browser self-tests on every pull request catch a change to them that alters what a frozen case does.

**When a held-out set is used up.** A held-out set stays held out only while nothing is tuned against it. If the prompt changes, or a model is chosen, after a held-out result has been seen, the next published number needs a new held-out set. A different model may be measured on an existing held-out set only if the choice to use it was made on the tuning set first.

**The case mix was fixed in advance.** Before h2's cases were written, its mix (how many selector, promotion and insert-step cases, how many decoys, refusals and survivals) was fixed as h1's proportions scaled up, and a test holds h2 to it. This stops a second set from avoiding the cases the first one showed to be hard, or from piling onto them.

## The report

The report is generated from a run's `results.json` by `report:drift`, and its format was fixed before any real numbers existed, so it could not be chosen to flatter a result. Every report includes:

- **a header:** the suite version and its hash, the provider and model, prices and budget, runs per case, the acceptance policy, and the judge's definition of correct;
- **a heal quality table:** single changes, complex changes, decoy traps and all healable cases, each with cases, runs attempted, verified, correct, false heals and the false-heal rate with its interval;
- **a refusals table,** naming every gap case;
- **never-reached counts,** excluded from every rate;
- **supporting figures:** heal rate, oracle agreement, cost and confidence bands, followed by a per-case table.

A one-sentence headline is printed only if nothing rules it out. The report withholds it, and says why at the top, for a dry run, a partial suite, an unknown suite or one whose hash does not match, the tuning set, fewer than three runs per case, unpriced model calls, or a run that stopped early on a provider error.

## Limits of the method

These are the reasons to read the figures carefully, not only the reasons they might be wrong.

- **The changes are synthetic.** They are modelled on common kinds of site change, but their frequency is a choice, not a sample of how real sites drift. A different mix would give a different heal rate, which is why every figure is split by group rather than pooled.
- **The cases and fixtures were written by the Starfysh developer.** Holding sets out guards against tuning, not against a shared blind spot. Cases written by someone else, or drift taken from real sites, would be a stronger test.
- **The fixtures are small.** Each is a single page of about eight steps. Real pages are larger and noisier, and the healer sees only the start of a long accessibility tree.
- **One browser, one model at a time.** Runs use Chromium and name a single model. A result for one model says nothing about another.
- **The benchmark removes the human reviewer.** That makes the false-heal rate a measure of the healer alone. In real use a reviewer sees every model-written patch first, so the rate at which a wrong patch reaches production should be lower, but it is not zero, and the benchmark does not measure it.
- **Silent breakages are counted, not caught.** A change that leaves the workflow passing with wrong outputs never reaches the healer, so it appears in neither rate. The `silent` count shows how many such cases a suite contains.

## Reproducing the results

The benchmark runs offline apart from the model calls. From the repository root:

```sh
pnpm install
pnpm --filter @sfysh/benchmark exec playwright-core install chromium chromium-headless-shell
pnpm --filter @sfysh/benchmark test:drift
pnpm --filter @sfysh/benchmark heal:drift -- --cases h2 --runs 3 --provider anthropic --model <id> --price-in <usd> --price-out <usd> --max-usd 3
pnpm --filter @sfysh/benchmark report:drift -- results/drift-<timestamp>
```

The first `heal:drift` option chooses the case set (`v1`, `h1` or `h2`). A free dry run with `--provider oracle` answers every case with its oracle heal, which checks the harness without calling a model. See [`benchmark/README.md`](../../benchmark/README.md) for every option and for how to add a case.
