# @sfysh/cli

The Starfysh command-line front end. Exposes a single binary, `compile`, that drives the rest of the Starfysh toolchain.

## Status

In progress. The commands wired up today are `compile parse`, `compile verify`, `compile heal`, `compile approve`, `compile reject` and `compile revert`. `emit` and `bench` are still to come. The healer behind `compile heal` has not yet been run against a real model.

The package is private (`"private": true`) until the surface stabilises.

## Install

Not yet published. Use the workspace symlink during development.

```sh
pnpm add @sfysh/cli@workspace:*
pnpm --filter @sfysh/cli build
```

The `bin` entry points at `dist/bin.js`, so the CLI needs to be built before it can be invoked. That matches the rest of the monorepo: source entry points for tooling, built entry points for anything the user runs.

## Commands

### `compile parse <file>`

Parses a Playwright TypeScript file into a Starfysh workflow IR and prints the JSON to stdout.

```sh
compile parse examples/submit-report.spec.ts
compile parse examples/submit-report.spec.ts --out submit-report.workflow.json
```

Options:

- `--out <path>` writes the JSON to a file instead of stdout. Exit status is 0 on success.
- `-h`, `--help` shows usage.

Exit codes:

- `0` on success.
- `1` on parse errors, missing files, or unknown arguments.

### `compile verify <file>`

Replays a Starfysh IR workflow against a Page backend, evaluates terminal postconditions, and compares outputs across runs. The CLI stays browser-agnostic: the backend is supplied as a path to a module that exports `pageFactory` and `runner` (and optionally `dispose` and `tolerance`). A typical backend wires Playwright through `@sfysh/playwright-adapter` and calls `run(id, page)` from `@sfysh/runtime`.

```sh
compile verify supplier-portal.workflow.json --backend ./backend.mjs
compile verify supplier-portal.workflow.json --backend ./backend.mjs --runs 5 --json
compile verify supplier-portal.workflow.json --backend ./backend.mjs --out report.txt
```

Backend module contract:

```ts
import type { PageFactory, RunnerFn, PageDisposer, ToleranceMap } from '@sfysh/verifier';

export const pageFactory: PageFactory;
export const runner: RunnerFn;
export const dispose?: PageDisposer;
export const tolerance?: ToleranceMap;
```

Options:

- `-b`, `--backend <path>` path to the backend module (required).
- `-n`, `--runs <count>` number of replays (default 3).
- `--timeout <ms>` fail a replay that runs longer than this many milliseconds, then carry on with the next. No limit by default.
- `--json` emit a JSON report instead of a human-readable one.
- `-o`, `--out <path>` write the report to a file instead of stdout.
- `-h`, `--help` shows usage.

Exit codes:

- `0` when every replay passed and outputs were stable across runs.
- `1` on usage, IO, or workflow-validation errors.
- `2` when one or more replays failed or outputs drifted across runs.

### `compile heal <file>`

Runs a workflow once against a live backend with the IR interpreter.

- **If it passes**, its outputs are saved as the workflow's known-good outputs, and nothing else happens. Run it once while the site works, so a later heal has something to hold a patch to.
- **If it fails**, `@sfysh/healer` takes over: triage decides whether the failure is a site change at all, a model proposes a patch to the failed step, and the patched workflow is replayed live at least three times and must reproduce the known-good outputs. A patch that verifies is saved as pending and its review is printed. **Nothing a model wrote is applied** until a person runs `compile approve`.
- **If it passes only on a fallback selector** (the step's first selector failed and a lower-ranked one worked), the run is degraded. The working selector is moved to the front of its step: a promotion, built in code with no model. It is verified the same way and held for approval like any other patch, unless `--auto-promote` is set.

```sh
compile heal orders.workflow.json --backend ./backend.mjs --provider anthropic
# Exit 3: heal 6f1c... is waiting for approval.
compile approve 6f1c... --reviewer dana   # writes the patched workflow over orders.workflow.json
compile reject 6f1c... --reviewer dana --note "Opens archived orders, not current ones."
```

The backend module needs only `pageFactory`. Its `runner` is not used, because the healer verifies with the IR interpreter and the interpreter is what confirms that the patched step actually ran. It may also export:

```ts
import type { Provider } from '@sfysh/providers';

export const provider?: Provider; // used when --provider is not given
export const params?: Record<string, string>; // values for { param } references
export const dispose?: PageDisposer;
export const vaultResolver?: VaultResolver; // default: SFYSH_SECRET_<NAME>, declared secrets only
export const tolerance?: ToleranceMap; // fields allowed to differ from the known-good outputs
```

Options:

- `-b`, `--backend <path>` path to the backend module (required).
- `-p`, `--provider <name>` `anthropic`, `openai`, `gemini` or `ollama`. Each reads its API key from its usual environment variable. Overrides the backend's `provider`.
- `-m`, `--model <name>` model for `--provider`.
- `--known-good <path>` a JSON file of outputs to hold patches to (an array, or `{ "outputs": [...] }`), instead of the saved ones.
- `--dir <path>` state directory (default `.compile`).
- `-n`, `--runs <count>` live runs to verify a patch with (default and minimum 3).
- `--timeout <ms>` fail a run that takes longer than this.
- `--json` emit JSON (status, heal id, pending path and the corpus record) instead of the review. For a heal waiting for approval, the record leaves out the shadow-mode verdict (`wouldAutoAccept`), so nothing that presents the review can nudge the reviewer; the corpus keeps it.
- `--auto-promote` apply a verified promotion without asking. See below.

Exit codes:

- `0` the workflow passed, or passed on triage's single retry. Also a degraded pass whose promotion was applied (`--auto-promote`) or could not be made.
- `1` usage, IO or validation error, or no known-good outputs yet.
- `2` the failure was not healed: triage sent it elsewhere (re-authenticate, back off, a person), a limit stopped it, or no patch verified.
- `3` a verified patch is waiting for approval.

#### Automatic promotion (`--auto-promote`)

With `--auto-promote`, a verified promotion is applied without asking, and the command prints what changed and how to undo it. This is the only change `compile heal` ever makes on its own. The first time it is used with a state directory it prints what it does and what it risks:

- No model is involved. The selector was already in the workflow, written by a person, and has just worked on the live site.
- Before it is applied, the promoted workflow must pass at least three live runs using only its new first selector, and reproduce the outputs of the run that just passed.
- The risk: the fallback can be a different element that happens to give the same outputs. Outputs are compared with one known-good run, not a longer history yet, so a wrong element is not always caught.

Even with the flag, a promotion waits for a person when it undoes an earlier heal, or when a person has reverted the same change before. Model-written patches always wait for a person: automatic acceptance of those is planned, but only once the benchmark has shown the confidence score can be trusted.

### `compile approve <id>`, `compile reject <id>` and `compile revert <id>`

Answer a pending heal, or undo an applied one. All three require `--reviewer <name>`, which is recorded in the corpus.

`approve` checks the patch again before writing anything, because the pending file sits on disk and is not trusted on its own. It is refused if the workflow file changed since the heal (run the heal again), if the patched workflow on the pending file does not match the patch applied to the current file, or if the patch breaks any of the healer's rules. `--out <path>` writes the patched workflow elsewhere instead of over the original. Approval does not re-run verification, so approve soon after the heal.

`reject` leaves the workflow alone and takes an optional `--note`.

`revert` undoes an applied patch, whether a person approved it or `--auto-promote` applied it: it writes back the workflow exactly as it was before. It is refused if the workflow file has changed since the patch was applied (a later heal or a hand edit), rather than silently dropping that change. It takes an optional `--note`. Once reverted, the same change is never applied automatically again.

### State

Everything `compile heal` remembers lives under `.compile/` (or `--dir`):

| Path                        | What                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `corpus/heals.jsonl`        | Every heal and every review. Page content is stored as hashes. See the `@sfysh/healer` README.                                                             |
| `heal-history.jsonl`        | When heals ran, for the cap of three heals per workflow per day, and what each held or accepted patch changed, to catch a heal that undoes an earlier one. |
| `known-good/<id>.json`      | Outputs of the workflow's last passing run. This is extracted page data; treat it like the outputs themselves.                                             |
| `pending/<heal id>.json`    | A verified patch waiting for a person. Removed on approve or reject.                                                                                       |
| `applied/<heal id>.json`    | The workflow as it was before an applied patch, for `compile revert`. Removed on revert.                                                                   |
| `auto-promote-acknowledged` | Marks that the `--auto-promote` risk notice has been shown. Delete it to see the notice again.                                                             |

Keep `.compile/` out of version control. Run one `compile heal` at a time per state directory.

## Design notes

The argv parser is Node's built-in `node:util.parseArgs`. It still covers five commands comfortably, because none of them needs nested subcommands or generated help. Moving to a framework (cac, commander) stays deferred until one does.

The command logic lives in `src/run.ts` (argument parsing), `src/verify.ts` and `src/heal.ts` (the commands as plain async functions), and is pure apart from the files it is told to read and write: argv, stdout and stderr are passed in, and an exit code comes back. `src/bin.ts` is a four-line shebang shim that calls into it. This keeps everything testable without spawning subprocesses.
