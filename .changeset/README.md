# Changesets

This folder is managed by [@changesets/cli](https://github.com/changesets/changesets).

## Workflow

**Adding a changeset (required for every PR that changes a published package):**

```sh
pnpm changeset
```

This creates a Markdown file in `.changeset/` describing which packages changed and at what semver level (patch / minor / major). Commit that file with your PR.

**Releasing (run by CI on merge to main):**

```sh
pnpm changeset version   # bumps package.json versions and writes CHANGELOG entries
pnpm changeset publish   # publishes changed packages to npm
```

The release workflow in `.github/workflows/release.yml` automates both steps on every push to `main` using the Changesets GitHub Action.

## Packages

| Package                     | Description                                          |
| --------------------------- | ---------------------------------------------------- |
| `@sfysh/ir`                 | IR schema, types, and Ajv validators                 |
| `@sfysh/compiler`           | Templated codegen pipeline                           |
| `@sfysh/runtime`            | Starfysh runtime helpers (vault, emit, assert, poll) |
| `@sfysh/playwright-adapter` | Playwright-to-Starfysh bridge                        |

## Notes

- The root workspace package and `benchmark/` are private and never published.
- `updateInternalDependencies` is set to `"patch"` so workspace-dep version pins are kept tight after each release.
- Do not manually edit files in this directory other than adding new changeset Markdown files via the CLI.
