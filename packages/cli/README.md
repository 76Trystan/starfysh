# @sfysh/cli

The Starfysh command-line front end. Exposes a single binary, `compile`, that drives the rest of the Starfysh toolchain.

## Status

Scaffolded. The only command wired up today is `compile parse`. `verify`, `heal`, `emit`, and `bench` land once their underlying packages exist (see `docs/planning/ToDo.md`).

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

## Design notes

The argv parser is Node's built-in `node:util.parseArgs`. Adding a dedicated CLI framework (cac, commander) is deferred until there are three or more commands shaping the ergonomics. That decision will warrant its own ADR when the time comes.

The command logic lives in `src/run.ts` and is pure: it reads argv, stdout, and stderr as parameters and returns an exit code. `src/bin.ts` is a four-line shebang shim that calls into it. This keeps everything testable without spawning subprocesses.
