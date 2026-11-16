# Starfysh

[![CI](https://github.com/76Trystan/starfysh/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/76Trystan/starfysh/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)

A browser-automation compiler that turns one AI-recorded session into a deterministic, self-healing script. The agent authors the code once, the runtime runs it indefinitely.

> **Status: Phase 1 in progress.** The paragraph above is the vision. Phase 0 (IR, compiler, runtime, Playwright adapter) shipped on npm at 0.1.x and has since seen several minor releases. Phase 1 (parser, verifier, triage, healer, CLI, MCP server) is in progress. The parser and verifier are published on npm. The triage classifier, model providers, CLI, and the healer's patch pipeline work inside the repo but are not yet published, and the healer does not yet apply or accept patches. The sections below separate what you can use today from what is coming.

## What ships today

Six `@sfysh/*` packages are published on npm today. The Phase 0 core gives you the deterministic middle of the pipeline; the parser and verifier are the first Phase 1 packages to ship.

| Package                                                                                                                                                                                                              | What it does                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@sfysh/ir`](https://www.npmjs.com/package/@sfysh/ir) [![npm](https://img.shields.io/npm/v/@sfysh/ir.svg)](https://www.npmjs.com/package/@sfysh/ir)                                                                 | JSON-Schema-first IR for Starfysh workflows, with Ajv validators and generated TypeScript types.                                                                                                                                               |
| [`@sfysh/compiler`](https://www.npmjs.com/package/@sfysh/compiler) [![npm](https://img.shields.io/npm/v/@sfysh/compiler.svg)](https://www.npmjs.com/package/@sfysh/compiler)                                         | Takes a validated IR workflow and emits deterministic TypeScript, byte-stable across runs.                                                                                                                                                     |
| [`@sfysh/runtime`](https://www.npmjs.com/package/@sfysh/runtime) [![npm](https://img.shields.io/npm/v/@sfysh/runtime.svg)](https://www.npmjs.com/package/@sfysh/runtime)                                             | The `workflow()` runner, `vault()` secret resolver, assertions, extraction helpers, and the `Page`/`Locator` interfaces that generated code targets.                                                                                           |
| [`@sfysh/playwright-adapter`](https://www.npmjs.com/package/@sfysh/playwright-adapter) [![npm](https://img.shields.io/npm/v/@sfysh/playwright-adapter.svg)](https://www.npmjs.com/package/@sfysh/playwright-adapter) | Casts Playwright's `Page` and `Locator` to the runtime's structural interfaces so Playwright-driven tests can run Starfysh workflows without rewriting them.                                                                                   |
| [`@sfysh/parser`](https://www.npmjs.com/package/@sfysh/parser) [![npm](https://img.shields.io/npm/v/@sfysh/parser.svg)](https://www.npmjs.com/package/@sfysh/parser)                                                 | Lifts existing Playwright TypeScript scripts into the Starfysh IR so they can be verified and healed by the toolchain.                                                                                                                         |
| [`@sfysh/verifier`](https://www.npmjs.com/package/@sfysh/verifier) [![npm](https://img.shields.io/npm/v/@sfysh/verifier.svg)](https://www.npmjs.com/package/@sfysh/verifier)                                         | Replays a workflow N times against a live page, evaluates postconditions, checks output stability, and produces human or JSON reports. Can run the IR directly through an interpreter, and supports cassette replay for deterministic CI runs. |

Four more packages are in the repo but not yet published:

| Package            | What it does                                                                                                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@sfysh/triage`    | Deterministic failure classifier. Maps a failed run to a `FailureKind` (flake, auth, site, task, unknown) so the healer can route failures without invoking a model.                                                                                                                |
| `@sfysh/providers` | A small `Provider` interface over Anthropic, OpenAI, Gemini, and Ollama (or any OpenAI-compatible local server), with timeouts, a content-hash cache, and an outbound redaction hook so secrets never reach a model.                                                                |
| `@sfysh/healer`    | In progress. Builds a redacted prompt from a failure, asks a model for a selector patch or an inserted step, and checks the answer against scope, allowlist, origin, secret, and regex rules before scoring it on snapshot evidence. Does not yet verify, apply, or accept a patch. |
| `@sfysh/cli`       | Command-line front end for the toolchain (`compile parse`, `compile verify`; `compile heal` once the healer lands).                                                                                                                                                                 |

**What this means in practice.** You can hand-author a workflow IR following the schema in `@sfysh/ir`, compile it with `@sfysh/compiler`, and execute the result via `@sfysh/runtime` plus Playwright. Or start from an existing Playwright script, lift it into IR with `@sfysh/parser`, and feed it into the same pipeline. That is a working, deterministic path from JSON (or TypeScript) to a running browser automation.

**What is not here yet.** A healer that closes the loop (verifies a patch against the live site, shows you the diff, and ships it once you approve), and the MCP server that lets coding agents drive the stack. Those are the remaining components that take Starfysh from "a well-typed Playwright toolkit" to "an automation you can actually leave running". See the [roadmap](#roadmap).

## Try it in 5 minutes

Prerequisites: Node 22+ and the Playwright Chromium binary.

```sh
mkdir starfysh-demo && cd starfysh-demo
npm init -y
npm pkg set type=module
npm install @sfysh/runtime @sfysh/playwright-adapter playwright tsx
npx playwright install chromium
```

Create `demo.ts`:

```ts
import { chromium } from 'playwright';
import { workflow, run, createWorkflowContext } from '@sfysh/runtime';
import { asPage } from '@sfysh/playwright-adapter';

workflow('books-category-count', async ({ page, emit }) => {
  await page.goto('https://books.toscrape.com/catalogue/category/books/travel_2/index.html', {
    waitUntil: 'domcontentloaded',
  });
  const count = await page.locator('article.product_pod').count();
  emit.output({ category: 'travel', count });
});

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

const ctx = createWorkflowContext({ page: asPage(page) });
const result = await run('books-category-count', ctx);
console.log(result);
console.log('outputs:', ctx.drainOutputs());

await browser.close();
```

Run it:

```sh
npx tsx demo.ts
```

Expected output: a `RunResult` with `status: 'ok'`, and `outputs: [ { category: 'travel', count: 11 } ]` (give or take a book, since the site occasionally updates).

### Where `@sfysh/compiler` fits in

The `workflow()` call above was hand-written. The point of Starfysh is that the agent writes it. Given an IR document, `@sfysh/compiler` emits the same kind of file (a `workflow()` registration whose steps call `@sfysh/runtime`), byte-stable across runs. The simplest valid IR:

```json
{
  "irVersion": "1.0.0",
  "id": "books_category_count",
  "name": "Count books in Travel category",
  "steps": [
    {
      "id": "step_01_navigate",
      "intent": "Open the Travel category page.",
      "action": "navigate",
      "url": "https://books.toscrape.com/catalogue/category/books/travel_2/index.html"
    }
  ]
}
```

```ts
import { compileUnknown } from '@sfysh/compiler';
import ir from './workflow.json' with { type: 'json' };

// compileUnknown validates the JSON against the IR schema before compiling.
// Use compile() when you already hold a typed Workflow.
const { source } = await compileUnknown(ir);
console.log(source);
```

Today these IR documents are hand-authored, or lifted from an existing Playwright script with `@sfysh/parser`. A recorder that authors them from a single AI-driven browser session is planned for a later phase, after the healer.

## What this grows into

Browser automation has a trust problem. Hand-written scripts break every time a site redesigns, and someone has to fix them by hand. Live AI agents cost real money on every run and still fail in confident, unexplained ways. Neither of those is something you can leave running without a person watching it.

Starfysh is aimed squarely at that gap. The pitch in one line: browser automation you can actually leave running.

The mechanism is a compiler, not a runtime. The agent works through a task once in a real browser, under instrumentation, and the output is a Starfysh script: a typed, deterministic program that depends only on `@sfysh/runtime`. From then on, the script is what runs on your schedule. When the script eventually breaks, because sites always eventually change, a healer diagnoses the failure, patches the smallest possible piece, re-verifies against the live site, and shows you a readable diff of what changed and why. The agent is only in the loop for authoring and healing, never for ordinary runs.

**Playwright compatibility.** If you already run Playwright scripts, `@sfysh/playwright-adapter` lets you plug Playwright's page objects directly into Starfysh's runtime interfaces, so the healer and verifier work on your existing scripts without migration.

The compiler is how it works. The reliability is what it is for.

## Who it is for

Anyone who runs the same browser-based task repeatedly, cares that it keeps working, and is tired of being the person who fixes it at 3am when the vendor portal changes. Typical fits: data collection from sites without a real API, recurring reporting flows, internal tools that only expose a web UI, and any "I do this every Monday" task that a person keeps stealing back from automation because the automation kept breaking.

If your current options are "pay an agent to re-derive the same workflow every morning and hope" or "maintain a pile of brittle scripts by hand," this is aimed at you.

## How it fits together

```mermaid
flowchart LR
    A[You describe a task] --> B[Agent runs it once in a browser]
    B --> C[Compiler produces a Starfysh script]
    C --> D[Verifier replays the script<br/>and proves it works]
    D --> E[Scheduled runs use the script directly]
    E -->|Runs fine| E
    E -->|Something breaks| F[Healer diagnoses the failure]
    F -->|Small patch| G[Re-verify and show a diff]
    G -->|You accept| E
    G -->|You reject| A
```

_Shipped: step C (compiler), step D (verifier, published on npm with live and cassette replay), and step E (scheduled runtime execution, via `@sfysh/runtime` and `@sfysh/playwright-adapter`). In progress for Phase 1: steps F and G (triage and patch generation exist in the repo; verifying, diffing, and accepting a patch do not yet). Steps A and B (agent-driven authoring) come in a later phase; until then, the entry point is a hand-written IR or an existing Playwright script lifted by `@sfysh/parser`._

Two things in that diagram are the whole point. First, the self-loop at `E`: ordinary runs never touch the agent, so they are fast, cheap, and predictable. Second, the path through `F` and `G`: when something breaks, you do not get a mysterious failure and a rewritten script. You get a diagnosis, the smallest possible patch, fresh evidence that it works, and a diff you can read in ten seconds before accepting.

## What we measure

Reliability only means something if it is measurable. The numbers Phase 1 tracks across every workflow and run:

- **Mean time between heals.** How long a script survives in the wild before something breaks.
- **Heal success rate.** Of failures the healer attempts, how many produce a patch that verifies.
- **False-heal rate.** Of patches that verify, how many silently do the wrong thing.
- **Time-to-heal.** Wall clock from breakage detected to patched script running again.
- **Human intervention rate.** What percentage of heals need a person to weigh in before shipping.

The intent is to report these honestly rather than selectively.

## Roadmap

### Phase 0: Foundations (shipped)

The deterministic core, published on npm. See [What ships today](#what-ships-today) for the per-package detail. The baseline (typecheck, format, growing Vitest suite) is green and a benchmark harness runs five real-site tasks.

### Phase 1: Healer-first MVP (in progress)

The pieces that take Starfysh from "foundations" to "an automation you can actually leave running."

Done so far:

- `@sfysh/parser` is published and lifts Playwright scripts into IR, including unsupported-call reporting and `extract` steps for data-read patterns.
- `@sfysh/verifier` is published and replays workflows N times with postcondition evaluation, output-stability checks, an IR interpreter, and cassette replay.
- `@sfysh/triage` classifies failures deterministically without a model: postcondition results first, then typed runtime errors, with HTTP status rules reserved for Phase 2.
- `@sfysh/providers` wraps Anthropic, OpenAI, Gemini, and Ollama behind one interface, with redaction applied before anything leaves the process.
- `@sfysh/healer` turns a failure into a candidate patch (a new set of ranked selectors, or one inserted `click` or `wait`), rejects anything outside a narrow allowlist, and scores what remains against the page snapshot.
- `@sfysh/cli` drives parse and verify from the command line.

Remaining: the healer's verify-and-approve loop with a readable semantic diff, the MCP server so coding agents can drive the stack, a 20-task benchmark with a synthetic-drift suite to measure the false-heal rate, and a private beta followed by the public launch.

### Phase 2: API healing

The IR, triage classifier, verifier, and false-heal metric are designed to be surface-agnostic. Phase 2 extends them to the HTTP APIs that workflows call: a `request` action in the IR, triage classes for contract drift and deprecation headers, and contract-aware patches. Additional vault backends (Doppler, AWS Secrets Manager) land here too. Phase 2 does not start until the browser benchmark has run and the first false-heal rate is published.

## Longer-term direction

Browser workflows come first because they are the hardest unsolved healing surface, and APIs follow in Phase 2. Beyond that, the plan is to deliver heals as pull requests against your own repository, and later to add a hosted runner and the authoring agent (the recorder in steps A and B of the diagram above). None of that is being built this quarter.

## Local development

Setup instructions for picking the project up on a fresh machine. The repo is a pnpm workspace running Node 22 LTS. The same commands work on macOS, Windows, and Linux once the prerequisites are in place.

### Prerequisites

**Node 22 LTS or newer.** Verify with `node --version`. If missing:

- macOS: `brew install node@22`, or install via [fnm](https://github.com/Schniz/fnm), [Volta](https://volta.sh/), or [nvm](https://github.com/nvm-sh/nvm).
- Windows: `winget install OpenJS.NodeJS.LTS`, or download the installer from [nodejs.org](https://nodejs.org/).
- Linux: use your distro's package manager, `nvm`, or `fnm`.

**pnpm 10.x.** The version is pinned in the root `package.json` via `packageManager`. The simplest install is Corepack, which ships with Node:

```sh
corepack enable
corepack prepare pnpm@latest --activate
pnpm --version
```

#### Windows caveat: Corepack and Node in Program Files

If Node was installed to `C:\Program Files\nodejs\`, Corepack cannot write its shims there without admin rights and the enable step fails with `EPERM`. Either run an elevated PowerShell window, or install pnpm standalone to your user profile:

```powershell
Invoke-WebRequest -UseBasicParsing "https://get.pnpm.io/install.ps1" -OutFile "$env:TEMP\pnpm-install.ps1"
& "$env:TEMP\pnpm-install.ps1"
```

Open a new terminal after installation so pnpm is on your PATH.

### Clone and install

```sh
git clone https://github.com/76Trystan/starfysh.git
cd starfysh
pnpm install
```

The first install takes around 30 seconds. `node_modules/` is gitignored; `pnpm-lock.yaml` is committed, so do not delete it.

### Verify the baseline

Run all three before and after every change. They are the invariant the whole project builds on:

```sh
pnpm typecheck
pnpm format:check
pnpm test
```

All three must pass. If any fails on a fresh clone, something has broken that should not have.

### Common commands

| Command                                | What it does                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm install`                         | Install workspace dependencies.                                                           |
| `pnpm typecheck`                       | `tsc --noEmit` across every workspace package.                                            |
| `pnpm test`                            | Vitest run across every workspace package.                                                |
| `pnpm test:watch`                      | Vitest in watch mode for the active package.                                              |
| `pnpm format`                          | Apply Prettier formatting in place.                                                       |
| `pnpm format:check`                    | Verify formatting without writing.                                                        |
| `pnpm --filter @sfysh/ir regen-types`  | Regenerate `packages/ir/src/types.ts` from the JSON schemas. Run after any schema change. |
| `pnpm --filter @sfysh/<pkg> test`      | Run tests for a single package.                                                           |
| `pnpm --filter @sfysh/benchmark bench` | Run the real-browser benchmark suite. See [`benchmark/README.md`](./benchmark/README.md). |

### Editor setup

Any TypeScript-aware editor works. VS Code picks up `tsconfig.base.json` and the per-package `tsconfig.json` files automatically. Recommended extensions: Prettier, ESLint (when it lands), and the official JSON Schema extension so workflow files get live validation against the schema (triggered by the `$schema` pointer at the top of each example).

### Where to start contributing

1. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) for conventions and the baseline-green requirement.
2. Pick an open issue or propose a change.
3. Make the change. Keep `pnpm typecheck + format:check + test` green on every commit.

## Documentation

See [`docs/reference/ir-schema.md`](./docs/reference/ir-schema.md) for the IR schema reference. Package-level docs live under each `packages/<name>/README.md`.
