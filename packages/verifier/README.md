# @sfysh/verifier

Replays a Starfysh workflow N times against a `Page` backend, evaluates postconditions, compares outputs across runs for stability, and produces either a human-readable or JSON report. The verifier is the gate that turns an IR workflow into something the scheduler is allowed to run unattended.

## Status

Phase 1 scaffold. Package is private (`"private": true` in `package.json`) and will stay that way until the healer is wired through. Follow the Phase 1 checklist in `docs/planning/ToDo.md` for the current state.

## What it does

Given an IR workflow and a `runner` callback that knows how to execute the workflow against a `Page`, the verifier:

- Replays the workflow N times (default 3) against fresh Page instances.
- Captures outputs from each run (via `drainOutputs` in `@sfysh/runtime`).
- Evaluates workflow-level `pre` and `post` conditions against the live page.
- Compares outputs across runs with per-field tolerance, so that a field that legitimately varies (a timestamp, a pagination cursor) does not get flagged as drift.
- Records a timing envelope (min, max, mean) so a scheduler can later distinguish "slow" from "stuck".
- Produces a `VerifyReport` containing per-run outcomes, stability findings, and timings.

The healer reads this report shape to decide whether a patch has stabilised the workflow.

## Usage

```ts
import { verify, humanReport } from '@sfysh/verifier';
import { run } from '@sfysh/runtime';
import type { Workflow } from '@sfysh/ir';

const report = await verify(workflow, {
  pageFactory: () => createMyPage(),
  runner: async (page) => {
    await run(workflow.id, page);
  },
  runs: 3,
  tolerance: { timestamp: 'ignore', price: { kind: 'number', epsilon: 0.01 } },
});

process.stdout.write(humanReport(report));
```

`pageFactory` is called once per replay so each run starts from a fresh session.

## Why the runner is pluggable

The verifier does not interpret IR directly. It takes a `runner` callback so the same reporting surface can wrap:

- the runtime `run()` call against compiled Starfysh scripts,
- a Playwright test wrapped by `@sfysh/playwright-adapter`,
- a future IR interpreter introduced by the healer.

Keeping execution behind a callback stops the verifier from accreting a second workflow executor that would drift from the runtime.

## Dependencies

- `@sfysh/ir` for workflow and condition types.
- `@sfysh/runtime` for the `Page` and `Locator` interfaces and `drainOutputs`.
