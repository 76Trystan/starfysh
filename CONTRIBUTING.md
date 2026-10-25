# Contributing to Starfysh

## Adding a new package

Create a directory under `packages/<name>`. Each package must be independently importable and should follow the conventions in the existing packages:

- `package.json` with `"type": "module"`, `"private": true` (until published), and scripts for `build`, `typecheck`, and `test`
- `tsconfig.json` extending `../../tsconfig.base.json`
- `src/index.ts` as the public barrel export
- `test/` directory with Vitest tests

After creating the package, add it to the workspace by ensuring `pnpm-workspace.yaml` includes `packages/*` (it already does, so no change needed for packages under `packages/`).

## Baseline invariant

Every commit must keep this green:

```sh
pnpm typecheck && pnpm format:check && pnpm test
```

Run it before opening a pull request. CI enforces the same check.

## Code style

Prettier handles formatting. Run `pnpm format` to fix issues before committing.

TypeScript is strict (`strict: true`, `noUncheckedIndexedAccess: true`). Do not use `any` or non-null assertions (`!`) without a comment explaining why they are safe.

## Architecture decisions

If a change makes or alters a load-bearing design choice, write an ADR in `docs/architecture/decisions/` using the template at `docs/architecture/decisions/template.md`. See the existing ADRs for examples of the expected level of detail.

## Documentation

- Architecture decisions go in `docs/architecture/decisions/`.
- Root causes and fixes go in `docs/development/gotchas.md`.
- Headline notices go in `README.md`.
- Build progress goes in `docs/planning/ToDo.md`.

See `CLAUDE.md` for the full documentation policy.

## Reporting issues

Open an issue on GitHub. For security vulnerabilities, see `SECURITY.md` instead.
