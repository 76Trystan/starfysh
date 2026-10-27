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

## Documentation

- Headline notices and the IR schema reference go in `README.md` and `docs/reference/`.
- Package-level docs live under each `packages/<name>/README.md`.

## Reporting issues

Open an issue on GitHub. For security vulnerabilities, see `SECURITY.md` instead.
