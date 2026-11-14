# Starfysh

[![CI](https://github.com/76Trystan/starfysh/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/76Trystan/starfysh/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)

A browser-automation compiler that turns one AI-recorded session into a deterministic, self-healing script. The agent authors the code once, the runtime runs it indefinitely.

> **Status: Phase 1 in progress.** The paragraph above is the vision. Phase 0 (IR, compiler, runtime, Playwright adapter) shipped on npm at 0.1.x and has since seen several minor releases. Phase 1 (parser, triage, verifier, healer, CLI, MCP server) is in progress -- the parser is published on npm, the triage classifier and verifier are functional but not yet published, and the CLI drives the toolchain locally. The sections below separate what you can use today from what is coming.

## What ships today

Five `@sfysh/*` packages are published on npm today. The Phase 0 core gives you the deterministic middle of the pipeline; the parser is the first Phase 1 package to ship.

| Package                                                                                                                                                                                                              | What it does                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@sfysh/ir`](https://www.npmjs.com/package/@sfysh/ir) [![npm](https://img.shields.io/npm/v/@sfysh/ir.svg)](https://www.npmjs.com/package/@sfysh/ir)                                                                 | JSON-Schema-first IR for Starfysh workflows, with Ajv validators and generated TypeScript types.                                                             |
| [`@sfysh/compiler`](https://www.npmjs.com/package/@sfysh/compiler) [![npm](https://img.shields.io/npm/v/@sfysh/compiler.svg)](https://www.npmjs.com/package/@sfysh/compiler)                                         | Takes a validated IR workflow and emits deterministic TypeScript, byte-stable across runs.                                                                   |
| [`@sfysh/runtime`](https://www.npmjs.com/package/@sfysh/runtime) [![npm](https://img.shields.io/npm/v/@sfysh/runtime.svg)](https://www.npmjs.com/package/@sfysh/runtime)                                             | The `workflow()` runner, `vault()` secret resolver, assertions, extraction helpers, and the `Page`/`Locator` interfaces that generated code targets.         |
| [`@sfysh/playwright-adapter`](https://www.npmjs.com/package/@sfysh/playwright-adapter) [![npm](https://img.shields.io/npm/v/@sfysh/playwright-adapter.svg)](https://www.npmjs.com/package/@sfysh/playwright-adapter) | Casts Playwright's `Page` and `Locator` to the runtime's structural interfaces so Playwright-driven tests can run Starfysh workflows without rewriting them. |
| [`@sfysh/parser`](https://www.npmjs.com/package/@sfysh/parser) [![npm](https://img.shields.io/npm/v/@sfysh/parser.svg)](https://www.npmjs.com/package/@sfysh/parser)                                                 | Lifts existing Playwright TypeScript scripts into the Starfysh IR so they can be verified and healed by the toolchain.                                       |

Three more packages are in the repo but not yet published:

| Package           | What it does                                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@sfysh/triage`   | Deterministic failure classifier. Maps a failed run to a `FailureKind` (flake, auth, site, unknown) so the healer can route failures without invoking a model. |
| `@sfysh/verifier` | Replays a workflow N times against a live page, evaluates postconditions, checks output stability, and produces human or JSON reports.                         |
| `@sfysh/cli`      | Command-line front end for the toolchain: parse, compile, verify, and (soon) heal.                                                                             |

**What this means in practice.** You can hand-author a workflow IR following the schema in `@sfysh/ir`, compile it with `@sfysh/compiler`, and execute the result via `@sfysh/runtime` plus Playwright. Or start from an existing Playwright script, lift it into IR with `@sfysh/parser`, and feed it into the same pipeline. That is a working, deterministic path from JSON (or TypeScript) to a running browser automation.

**What is not here yet.** The healer that patches broken steps when sites change, and the MCP server that lets coding agents drive the stack. Those are the remaining components that take Starfysh from "a well-typed Playwright toolkit" to "an automation you can actually leave running". See the [roadmap](#roadmap).

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
import { workflow, run, emit, drainOutputs } from '@sfysh/runtime';
import { asPage } from '@sfysh/playwright-adapter';

workflow('books-category-count', async (page) => {
  await page.goto('https://books.toscrape.com/catalogue/category/books/travel_2/index.html', {
    waitUntil: 'domcontentloaded',
  });
  const count = await page.locator('article.product_pod').count();
  emit.output({ category: 'travel', count });
});

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

const result = await run('books-category-count', asPage(page));
console.log(result);
console.log('outputs:', drainOutputs());

await browser.close();
```

Run it:

```sh
npx tsx demo.ts
```

Expected output: a `RunResult` with `status: 'ok'`, and `outputs: [ { category: 'travel', count: 11 } ]` (give or take a book, since the site occasionally updates).

### Where `@sfysh/compiler` fits in

The `workflow()` call above was hand-written. The point of Starfysh is that the agent writes it. Given an IR document, `@sfysh/compiler` emits exactly this kind of file, byte-stable across runs. The simplest valid IR:

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
import { compile } from '@sfysh/compiler';
import ir from './workflow.json' with { type: 'json' };

const { source } = await compile(ir);
console.log(source);
```

In Phase 1, the recorder authors these IR documents from a single AI-driven browser session. Today they are hand-authored or scripted from your own traces.

## What this grows into

Browser automation has a trust problem. Hand-written scripts break every time a site redesigns, and someone has to fix them by hand. Live AI agents cost real money on every run and still fail in confident, unexplained ways. Neither of those is something you can leave running without a person watching it.

Starfysh is aimed squarely at that gap. The pitch in one line: browser automation you can actually leave running.

The mechanism is a compiler, not a runtime. The agent works through a task once in a real browser, under instrumentation, and the output is a Starfysh script -- a typed, deterministic program that depends only on `@sfysh/runtime`. From then on, the script is what runs on your schedule. When the script eventually breaks, because sites always eventually change, a healer diagnoses the failure, patches the smallest possible piece, re-verifies against the live site, and shows you a readable diff of what changed and why. The agent is only in the loop for authoring and healing, never for ordinary runs.

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

_Shipped: step C (compiler) and step E (scheduled runtime execution, via `@sfysh/runtime` and `@sfysh/playwright-adapter`). Step D (verifier) is functional in-repo. Steps A, B, F, and G are remaining Phase 1 scope._

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

The deterministic core, published on npm. See [What ships today](#what-ships-today) for the per-package detail. The baseline (typecheck, format, 226 tests) is green and a benchmark harness runs five real-site tasks.

### Phase 1: Healer-first MVP (in progress)

The pieces that take Starfysh from "foundations" to "an automation you can actually leave running." Progress so far: `@sfysh/parser` is published on npm and lifts Playwright scripts into IR; `@sfysh/triage` classifies failures deterministically without a model; `@sfysh/verifier` replays workflows N times with postcondition evaluation and output-stability checks; and `@sfysh/cli` drives parse, compile, and verify from the command line. Remaining: the healer that patches broken steps with reviewable diffs, the MCP server so coding agents can drive the stack, and a synthetic-drift benchmark to stress-test the healer and produce the reliability numbers the measurement section describes.

### Phase 2: Beta and polish

Private beta with real users, additional vault backends (Doppler, AWS Secrets Manager), a minimal docs site, and the public announcement.

## Longer-term direction

The healing stack at the centre of Starfysh is designed to be surface-agnostic. Browser workflows come first because they are the hardest unsolved healing surface. The architecture is kept deliberately open to extending to other surfaces with observable postconditions and cheap replay once the browser case is proven, but that is not what is being built this quarter.

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

The first install takes around 30 seconds and produces `node_modules/` and `pnpm-lock.yaml`. Both are gitignored except for the lockfile.

### Verify the baseline

Run all three before and after every change. They are the invariant the whole project builds on:

```sh
pnpm typecheck
pnpm format:check
pnpm test
```

All three must pass. If any fails on a fresh clone, something has broken that should not have.

### Common commands

| Command                               | What it does                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm install`                        | Install workspace dependencies.                                                           |
| `pnpm typecheck`                      | `tsc --noEmit` across every workspace package.                                            |
| `pnpm test`                           | Vitest run across every workspace package.                                                |
| `pnpm test:watch`                     | Vitest in watch mode for the active package.                                              |
| `pnpm format`                         | Apply Prettier formatting in place.                                                       |
| `pnpm format:check`                   | Verify formatting without writing.                                                        |
| `pnpm --filter @sfysh/ir regen-types` | Regenerate `packages/ir/src/types.ts` from the JSON schemas. Run after any schema change. |
| `pnpm --filter @sfysh/<pkg> test`     | Run tests for a single package.                                                           |

### Editor setup

Any TypeScript-aware editor works. VS Code picks up `tsconfig.base.json` and the per-package `tsconfig.json` files automatically. Recommended extensions: Prettier, ESLint (when it lands), and the official JSON Schema extension so workflow files get live validation against the schema (triggered by the `$schema` pointer at the top of each example).

### Where to start contributing

1. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) for conventions and the baseline-green requirement.
2. Pick an open issue or propose a change.
3. Make the change. Keep `pnpm typecheck + format:check + test` green on every commit.

## Documentation

See [`docs/reference/ir-schema.md`](./docs/reference/ir-schema.md) for the IR schema reference. Package-level docs live under each `packages/<name>/README.md`.
