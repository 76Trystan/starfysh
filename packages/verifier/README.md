# @sfysh/verifier

Replays a Starfysh workflow N times against a `Page` backend, evaluates postconditions, compares outputs across runs for stability, and produces either a human-readable or JSON report. The verifier is the gate that turns an IR workflow into something the scheduler is allowed to run unattended.

## Status

Phase 1 scaffold. Package is private (`"private": true` in `package.json`) and will stay that way until the healer is wired through. Follow the Phase 1 checklist in `docs/planning/ToDo.md` for the current state.

## What it does

Given an IR workflow and a `runner` callback that knows how to execute the workflow against a `Page`, the verifier:

- Replays the workflow N times (default 3) against fresh Page instances.
- Captures outputs from each run (via `drainOutputs` in `@sfysh/runtime`). Every `extract` step contributes one entry, keyed by its `bind` name or step id.
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

Secrets come from the `vaultResolver` option. When you leave it out, each replay uses the runtime's `EnvVaultResolver` limited to the names in the workflow's `secrets` list, so a runner that asks for a secret the workflow never declared fails with `VaultSecretNotAllowedError`.

Set `runTimeoutMs` to cap how long one replay may take. A replay that runs past it is recorded as failed with a `RunTimeoutError` and the verifier moves on to the next. There is no limit by default. The runner cannot be cancelled, so make sure your `dispose` closes the page, which ends whatever the runner was still doing.

When outputs differ between runs, `report.stability.drift` lists each field by its dotted path with the distinct values seen. A field that one run produced and another did not is listed with `missing: true`.

## What a failed replay tells you

Each entry in `report.replays` that failed carries:

- `error.stepId`, `error.action` and `error.selector`: the IR step that was running and the selector candidate it was using. Set for any failure inside compiled code, not only a violated condition.
- `error.phase`, `error.condition` and `error.reason`: set when a pre or post condition was violated.
- `error.cause`: the original thrown error, for passing to `@sfysh/triage` in the same process. It is not redacted, so it is a non-enumerable property and never appears in a report.
- `snapshot`: the page's accessibility tree as text, captured before the page is disposed, when the backend supports it (`@sfysh/playwright-adapter` does). Secrets are redacted and the length is capped. The human report notes that one was captured; the JSON report leaves it out. Treat it as untrusted page content.

To keep step attribution, use the bundled runner for compiled workflows:

```ts
import { verify, runRegisteredWorkflow } from '@sfysh/verifier';
import './my-workflow.js'; // compiled workflow, registers itself on import

const report = await verify(workflow, {
  pageFactory: () => createMyPage(),
  runner: runRegisteredWorkflow,
});
```

A runner that calls `run()` from `@sfysh/runtime` and re-throws `result.error.cause` loses the step id and selector, because the cause is the bare original error.

## Verifying straight from the IR

You do not have to compile a workflow to verify it. The bundled interpreter executes the IR's steps directly:

```ts
import { verify, interpretWorkflow } from '@sfysh/verifier';

const report = await verify(workflow, {
  pageFactory: () => createMyPage(),
  runner: interpretWorkflow,
});
```

This is the quickest way to check a workflow you have just edited: no generated file, no loader, and two versions of the same workflow id can run one after the other.

`createInterpreter(options)` builds a runner with options:

| Option       | What it does                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `candidates` | `'first'` (default) uses each step's first selector candidate, as generated code does. `'fallthrough'` retries a failed `click` or `fill` with the next ranked candidate. |
| `params`     | Values for `{ param }` references, keyed by parameter name.                                                                                                               |
| `onStep`     | Called as each step finishes with `{ stepId, action, status, durationMs, selector, candidateIndex, iterations }`.                                                         |

Under `'fallthrough'`, a run that passes with `candidateIndex` above 0 means the primary selector is broken. The compiled workflow only uses the first candidate and would fail, so treat that result as a prompt to fix the selector order, not as a pass.

The interpreter and generated code are kept in step by a test that runs both against the same scripted page and compares every page call. They differ in three deliberate ways. The interpreter:

- enforces `maxIterations` on loops (default 100) and `timeoutMs` on steps, failing with `LoopLimitError` or `StepTimeoutError`;
- evaluates conditions in `guard`, `wait`, `assert` and `loop.while` with the same evaluator as pre and post checks, so `urlMatches` accepts a substring there as well as a regex;
- accepts `{ param }` values, which the compiler does not support yet.

Generated code is still what ships and what runs on a schedule. If a workflow passes under the interpreter, run the compiled version once before relying on it.

## Why the runner is pluggable

The verifier takes a `runner` callback so the same reporting surface can wrap:

- `interpretWorkflow`, the bundled IR interpreter,
- `runRegisteredWorkflow`, which executes a compiled workflow registered with the runtime,
- any function of your own, for example one that drives a hand-written workflow.

Keeping execution behind a callback means the replay loop, the stability check and the reporters do not care how a workflow is executed.

## Dependencies

- `@sfysh/ir` for workflow and condition types.
- `@sfysh/runtime` for the `Page` and `Locator` interfaces and `drainOutputs`.
