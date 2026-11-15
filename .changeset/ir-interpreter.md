---
'@sfysh/verifier': minor
'@sfysh/ir': minor
'@sfysh/compiler': patch
---

Add an IR interpreter, so a workflow can be verified straight from its IR with no compile step.

**@sfysh/verifier.** New `interpretWorkflow` runner and `createInterpreter(options)` factory. Both are `RunnerFn`s, so they plug into `verify()` and `replayFromCassette()` unchanged:

```ts
import { verify, interpretWorkflow } from '@sfysh/verifier';

const report = await verify(workflow, { pageFactory, runner: interpretWorkflow });
```

The interpreter executes every IR action against the `Page`, using the same runtime helpers as generated code, so failures carry the same step id, action, selector and condition details. A parity test holds its sequence of page calls equal to the compiled code's. It differs from generated code in four deliberate ways: it enforces `maxIterations` on loops (default 100, per the schema) and `timeoutMs` on steps, throwing `LoopLimitError` and `StepTimeoutError`; it evaluates conditions in `guard`, `wait`, `assert` and `loop.while` with the same evaluator as pre and post checks; it leaves outputs in the context for the caller to drain instead of flushing them; and it accepts `{ param }` values through a `params` option.

Options: `candidates: 'first' | 'fallthrough'` (default `'first'`, which matches generated code; `'fallthrough'` retries a failed `click` or `fill` with the next ranked selector candidate), `params`, and `onStep`, a callback that receives a `StepTrace` (`stepId`, `action`, `status`, `durationMs`, `selector`, `candidateIndex`, `iterations`) as each step finishes. Under `'fallthrough'`, a pass with `candidateIndex > 0` means the primary selector is broken and the compiled workflow would fail.

**@sfysh/ir.** New export `parseRoleSelector(value)`, which reads the `role` selector format (`button[name='Sign in']`) into `{ role, options }`. The compiler and the interpreter both use it, so they cannot disagree about the format.

**@sfysh/compiler.** Role selector parsing now comes from `@sfysh/ir`. Generated output is unchanged.
