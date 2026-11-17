---
'@sfysh/compiler': minor
---

Generated code now matches the IR interpreter on loops, deadlines and conditions. It needs the matching `@sfysh/runtime` minor release.

- Loops call the runtime's `forEachItem` and `whileHolds`, so `maxIterations` (default 100) is enforced. Before, it was ignored and a `while` loop on a page that never changed ran for ever.
- A step's `timeoutMs` is passed to `step()` and enforced. Before, it was ignored.
- A `foreach` body is scoped to the current item: `item.getByRole(...)` instead of `page.getByRole(...)`. Before, every iteration acted on the first match on the whole page.
- Conditions in `guard`, `wait`, `assert` and `loop.while` are evaluated by the runtime's `conditionHolds`. Before, `urlMatches` there was compiled to `new RegExp(...)`, which threw on a pattern that is not a valid regex and never matched as a substring, unlike the same condition in `pre` or `post`.

The compiler now refuses, with `CompilerError`:

- an extract `bind` that is a reserved word, a name the generated function already uses (`page`, `ctx`, `emit`, `vault`, `item`, `extracted`, the runtime helpers), or a name bound twice;
- a `role` selector with a part it cannot read. Before, `button[name=Submit]` was compiled as `getByRole('button')`, silently dropping the name. Unquoted values are now read: `level=2` as a number, `exact=true` as a flag, `name=Submit` as text.
