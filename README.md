# Starfysh

A browser-automation compiler that turns one AI-recorded session into a deterministic, self-healing script. The agent authors the code once, the runtime runs it indefinitely.

## What this is

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

Two things in that diagram are the whole point. First, the self-loop at `E`: ordinary runs never touch the agent, so they are fast, cheap, and predictable. Second, the path through `F` and `G`: when something breaks, you do not get a mysterious failure and a rewritten script. You get a diagnosis, the smallest possible patch, fresh evidence that it works, and a diff you can read in ten seconds before accepting.

## What we measure

Reliability only means something if it is measurable. The numbers we care about, and intend to publish honestly, are:

- **Mean time between heals.** How long a script survives in the wild before something breaks.
- **Heal success rate.** Of failures the healer attempts, how many produce a patch that verifies.
- **False-heal rate.** Of patches that verify, how many silently do the wrong thing. This is the number that matters most, and the one nobody in this space wants to talk about.
- **Time-to-heal.** Wall clock from breakage detected to patched script running again.
- **Human intervention rate.** What percentage of heals need a person to weigh in before shipping.

If those numbers are good, this is a real product. If they are not, no amount of architecture around them fixes it.

## Status

Phase 0 of the MVP build is in progress. The IR schema (`packages/ir`) is drafted, validated, and type-safe; the compiler, verifier, healer, CLI, benchmark, and MCP server are all still to come. Current build state lives in [`docs/planning/ToDo.md`](./docs/planning/ToDo.md).

Order of landing, in priority: compiler + runtime + benchmark harness (Phase 0), then parser + verifier + healer + CLI + MCP server (Phase 1). The healer is the headline feature. Published false-heal rate is the headline metric.

## Local development

Setup instructions for picking the project up on a fresh machine. The repo is a pnpm workspace running Node 22 LTS. The same commands work on macOS, Windows, and Linux once the prerequisites are in place.

### Prerequisites

**Node 22 LTS or newer.** Verify with `node --version`. If missing:

- macOS: `brew install node@22`, or install via [fnm](https://github.com/Schniz/fnm), [Volta](https://volta.sh/), or [nvm](https://github.com/nvm-sh/nvm).
- Windows: `winget install OpenJS.NodeJS.LTS`, or download the installer from [nodejs.org](https://nodejs.org/).
- Linux: use your distro's package manager, `nvm`, or `fnm`.

**pnpm 9.x.** The version is pinned in the root `package.json` via `packageManager`. The simplest install is Corepack, which ships with Node:

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

Open a new terminal after installation so pnpm is on your PATH. This gotcha and its workarounds are also captured in [`docs/development/gotchas.md`](./docs/development/gotchas.md).

### Clone and install

```sh
git clone https://github.com/<your-fork>/agent-script-compiler.git
cd agent-script-compiler
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

All three must pass. If any fails on a fresh clone, something has broken that should not have; check [`docs/development/gotchas.md`](./docs/development/gotchas.md) for known issues and fixes.

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

1. Read [`CLAUDE.md`](./CLAUDE.md) for the working rules (documentation style, baseline-green requirement, no em dashes, how the ToDo list is maintained).
2. Read [`docs/planning/ToDo.md`](./docs/planning/ToDo.md) to see the current build state. Pick the lowest unchecked item in the current phase unless you have a specific reason to work out of order.
3. Make the change. Keep `pnpm typecheck + format:check + test` green on every commit.
4. If you make an architectural decision, add an ADR in [`docs/architecture/decisions/`](./docs/architecture/decisions/). If you hit and fix an unusual bug, add a dated entry to [`docs/development/gotchas.md`](./docs/development/gotchas.md).

## Documentation map

| Where                                                            | What                                                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [`docs/planning/ToDo.md`](./docs/planning/ToDo.md)               | Current build state and the full MVP plan, phased. Start here if you are picking up work.       |
| [`docs/architecture/decisions/`](./docs/architecture/decisions/) | Architecture Decision Records. Every load-bearing design choice is numbered and dated here.     |
| [`docs/development/gotchas.md`](./docs/development/gotchas.md)   | Issues hit, root causes, and fixes. Read this before re-debugging anything strange.             |
| [`CLAUDE.md`](./CLAUDE.md)                                       | Local-only operating manual. |
