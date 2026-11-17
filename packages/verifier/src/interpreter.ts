// IR interpreter: executes a workflow's steps directly against a Page,
// without compiling to TypeScript first.
//
// The compiler stays the way workflows ship. The interpreter exists for the
// loop where an IR changes and has to be re-checked straight away, which is
// what a healer does with every candidate patch. Going through generated
// code there means compile, write a file, load it through a TypeScript
// loader, and work around the registry refusing a second registration of
// the same id. The interpreter takes the IR object and runs it.
//
// It is built from the same runtime pieces generated code uses (`step`,
// `assertCondition`, `conditionHolds`, `poll`, `assert`, the emit sink),
// so failures come out in the same shape, and a parity test holds its
// sequence of Page calls equal to the compiled code's.
//
// Loop caps, step deadlines, flow conditions and `foreach` scoping go
// through the runtime helpers generated code calls (`forEachItem`,
// `whileHolds`, `conditionHolds`, `step` with `timeoutMs`), so the two
// executors share one implementation of each.
//
// Where the two differ on purpose:
//
// - Candidate fallthrough is available as an option (off by default).
// - `{ param }` values come from the `params` option; the compiler
//   cannot compile them yet.

import {
  parseRoleSelector,
  planExtract,
  validateWorkflow,
  type Condition,
  type SelectorCandidate,
  type Step,
  type Target,
  type ValueSource,
  type Workflow,
} from '@sfysh/ir';
import {
  assert,
  assertCondition,
  conditionHolds,
  DEFAULT_MAX_ITERATIONS,
  forEachItem,
  LoopLimitError,
  poll,
  step as runtimeStep,
  StepTimeoutError,
  whileHolds,
  type ColumnSchema,
  type Locator,
  type Page,
  type StepInfo,
  type WorkflowContext,
} from '@sfysh/runtime';
import type { RunnerFn } from './types.js';

/** Thrown when the interpreter cannot execute an IR construct. */
export class InterpreterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterpreterError';
  }
}

// The loop and timeout errors live in the runtime, which generated code
// also uses. Re-exported here so existing imports keep working.
export { DEFAULT_MAX_ITERATIONS, LoopLimitError, StepTimeoutError };

/** One executed step, reported to `InterpreterOptions.onStep` as it finishes. */
export interface StepTrace {
  stepId: string;
  action: string;
  status: 'ok' | 'failed';
  /** Wall-clock time for the step, including its pre and post checks and any nested steps. */
  durationMs: number;
  /** Selector candidate the step ended on. Absent for steps with no element target. */
  selector?: SelectorCandidate;
  /** Position of that candidate in the step's ranked list. 0 is the primary. */
  candidateIndex?: number;
  /** Number of iterations run. Only on `loop` steps. */
  iterations?: number;
}

export interface InterpreterOptions {
  /**
   * How to use a step's ranked selector candidates.
   *
   * - `'first'` (default): use the first candidate only. This is what
   *   generated code does, so a workflow that passes here passes when
   *   compiled.
   * - `'fallthrough'`: for `click` and `fill`, if the action fails with one
   *   candidate, try the next. The trace reports which candidate worked. A
   *   pass under this mode with `candidateIndex > 0` means the primary
   *   selector is broken and the compiled workflow would fail.
   */
  candidates?: 'first' | 'fallthrough';
  /** Values for `{ param }` references, keyed by parameter name. */
  params?: Record<string, string>;
  /** Called once for every step execution, after it finishes or fails. */
  onStep?: (trace: StepTrace) => void;
}

/**
 * Build a runner that interprets the workflow it is given. The result is a
 * `RunnerFn`, so it plugs into `replay()` and `replayFromCassette()` as is.
 */
export function createInterpreter(options: InterpreterOptions = {}): RunnerFn {
  return async (ctx, workflow) => {
    const check = validateWorkflow(workflow);
    if (!check.valid) {
      const first = check.errors[0];
      throw new InterpreterError(
        `workflow failed IR validation: ${first ? `${first.path} ${first.message}` : 'unknown error'}`,
      );
    }
    const run = new Run(ctx, options);
    await run.steps(workflow.steps);
  };
}

/** Interpreter with default options, ready to pass as a verifier `runner`. */
export const interpretWorkflow: RunnerFn = createInterpreter();

// The generated union leaves common fields optional and does not narrow
// cleanly on `action`, so the interpreter reads steps through this view.
// Every field is checked by validateWorkflow before a step gets here.
interface StepView {
  id: string;
  action: Step['action'];
  pre?: Condition[];
  post?: Condition[];
  timeoutMs?: number;
  url?: ValueSource;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  target?: Target;
  value?: ValueSource;
  schema?: Record<string, unknown>;
  bind?: string;
  forCondition?: Condition;
  millis?: number;
  condition?: Condition;
  if?: Condition;
  then?: Step[];
  else?: Step[];
  foreach?: Target;
  while?: Condition;
  maxIterations?: number;
  do?: Step[];
}

/** Where element lookups start: the page, or the current item inside a `foreach` body. */
type Root = Page | Locator;

/** Mutable record a step body fills in as it runs, for the trace. */
interface StepOutcome {
  selector?: SelectorCandidate;
  candidateIndex?: number;
  iterations?: number;
}

/** A value an extract step read, waiting for the post checks before it is emitted. */
interface PendingOutput {
  name: string;
  value: unknown;
}

class Run {
  constructor(
    private readonly ctx: WorkflowContext,
    private readonly options: InterpreterOptions,
  ) {}

  /**
   * Run a list of steps. `root` is where element lookups start: the page,
   * or the current item inside a `foreach` body, as in generated code.
   */
  async steps(steps: readonly Step[], root: Root = this.ctx.page): Promise<void> {
    for (const s of steps) await this.step(s as unknown as StepView, root);
  }

  private async step(s: StepView, root: Root): Promise<void> {
    const primary = (s.target ?? s.foreach)?.candidates[0];
    // `info` is what a failure is attributed to. The body updates
    // `info.selector` when it moves to another candidate, so a failure
    // names the selector that was actually in use.
    const info: StepInfo = {
      id: s.id,
      action: s.action,
      ...(primary ? { selector: { kind: primary.kind, value: primary.value } } : {}),
    };
    const outcome: StepOutcome = primary ? { selector: info.selector!, candidateIndex: 0 } : {};

    const started = Date.now();
    const finish = (status: StepTrace['status']): void => {
      this.options.onStep?.({
        stepId: s.id,
        action: s.action,
        status,
        durationMs: Date.now() - started,
        ...outcome,
      });
    };

    try {
      await runtimeStep(
        this.ctx,
        info,
        async () => {
          for (const c of s.pre ?? []) await assertCondition(this.ctx, s.id, 'pre', c);
          const pending = await this.body(s, info, outcome, root);
          for (const c of s.post ?? []) await assertCondition(this.ctx, s.id, 'post', c);
          // Emitted only once the post checks pass, as in generated code.
          if (pending) this.ctx.emit.output({ [pending.name]: pending.value });
        },
        s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {},
      );
    } catch (err) {
      finish('failed');
      throw err;
    }
    finish('ok');
  }

  private async body(
    s: StepView,
    info: StepInfo,
    outcome: StepOutcome,
    root: Root,
  ): Promise<PendingOutput | undefined> {
    const { page, emit } = this.ctx;

    switch (s.action) {
      case 'navigate': {
        const url = this.value(s.url!);
        if (s.waitUntil) await page.goto(url, { waitUntil: s.waitUntil });
        else await page.goto(url);
        return;
      }

      case 'click':
        await this.act(s.target!, info, outcome, root, (locator) => locator.click());
        return;

      case 'fill': {
        const value = this.value(s.value!);
        await this.act(s.target!, info, outcome, root, (locator) => locator.fill(value));
        return;
      }

      case 'extract': {
        // Read methods return an empty result when nothing matches instead
        // of throwing, so there is no failure to fall through on. Extract
        // always uses the primary candidate.
        const plan = planExtract(s.schema);
        if (plan.kind === 'unsupported') {
          throw new InterpreterError(`extract step '${s.id}' cannot be executed: ${plan.reason}`);
        }
        const locator = this.locate(primaryOf(s.target!, s.id), root);
        const value =
          plan.kind === 'value'
            ? await emit.value(locator)
            : plan.kind === 'list'
              ? await emit.list(locator)
              : await emit.table(locator, plan.columns as ColumnSchema);
        return { name: s.bind ?? s.id, value };
      }

      case 'wait':
        if (s.forCondition) {
          const condition = s.forCondition;
          await poll(async () => await conditionHolds(page, condition, s.id));
        }
        if (s.millis) await page.waitForTimeout(s.millis);
        return;

      case 'assert':
        assert(await conditionHolds(page, s.condition!, s.id));
        return;

      case 'guard':
        if (await conditionHolds(page, s.if!, s.id)) {
          await this.steps(s.then!, root);
        } else if (s.else) {
          await this.steps(s.else, root);
        }
        return;

      case 'loop': {
        const max = s.maxIterations ?? DEFAULT_MAX_ITERATIONS;
        outcome.iterations = 0;
        const iteration = (): void => {
          outcome.iterations = (outcome.iterations ?? 0) + 1;
        };
        if (s.foreach) {
          // The body is scoped to each item: its targets are looked up
          // within the item, not across the page.
          const items = await this.locate(primaryOf(s.foreach, s.id), root).all();
          await forEachItem(s.id, max, items, async (item) => {
            iteration();
            await this.steps(s.do!, item);
          });
        } else {
          await whileHolds(page, s.id, s.while!, max, async () => {
            iteration();
            await this.steps(s.do!, root);
          });
        }
        return;
      }

      default:
        throw new InterpreterError(`unknown step action: ${String(s.action)}`);
    }
  }

  /**
   * Run an element action against the step's target. In `'first'` mode the
   * primary candidate is used and its error, if any, propagates. In
   * `'fallthrough'` mode each usable candidate is tried in rank order until
   * one succeeds. The action is attempted for real each time, not probed
   * for first, so the backend's own waiting applies: an element that is
   * still rendering is not mistaken for a missing one. If every candidate
   * fails, the primary candidate's error is the one reported.
   */
  private async act(
    target: Target,
    info: StepInfo,
    outcome: StepOutcome,
    root: Root,
    action: (locator: Locator) => Promise<void>,
  ): Promise<void> {
    if (this.options.candidates !== 'fallthrough') {
      await action(this.locate(primaryOf(target, info.id), root));
      return;
    }

    const usable = target.candidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => candidate.kind !== 'visual');
    if (usable.length === 0) {
      throw new InterpreterError(
        `step '${info.id}' has only visual selector candidates, which are not supported`,
      );
    }

    let firstError: unknown;
    for (const { candidate, index } of usable) {
      const selector = { kind: candidate.kind, value: candidate.value };
      info.selector = selector;
      outcome.selector = selector;
      outcome.candidateIndex = index;
      try {
        await action(this.locate(candidate, root));
        return;
      } catch (err) {
        if (firstError === undefined) firstError = err;
      }
    }

    const first = usable[0]!;
    const selector = { kind: first.candidate.kind, value: first.candidate.value };
    info.selector = selector;
    outcome.selector = selector;
    outcome.candidateIndex = first.index;
    throw firstError;
  }

  private locate(candidate: SelectorCandidate, root: Root): Locator {
    switch (candidate.kind) {
      case 'role': {
        const { role, options, unparsed } = parseRoleSelector(candidate.value);
        if (unparsed.length > 0) {
          throw new InterpreterError(
            `role selector ${JSON.stringify(candidate.value)} has parts that cannot be read: ${unparsed.map((p) => JSON.stringify(p)).join(', ')}`,
          );
        }
        return Object.keys(options).length === 0
          ? root.getByRole(role)
          : root.getByRole(role, options);
      }
      case 'testid':
        return root.getByTestId(candidate.value);
      case 'text':
        return root.getByText(candidate.value);
      case 'label':
        return root.getByLabel(candidate.value);
      case 'css':
        return root.locator(candidate.value);
      case 'visual':
        throw new InterpreterError(
          `visual selector '${candidate.value}' cannot be executed: visual fallback is not implemented`,
        );
      default:
        throw new InterpreterError(
          `unknown selector kind: ${String((candidate as { kind: string }).kind)}`,
        );
    }
  }

  private value(source: ValueSource): string {
    if (typeof source === 'string') return source;
    if ('secret' in source) return this.ctx.vault(source.secret);
    const supplied = this.options.params?.[source.param];
    if (supplied === undefined) {
      throw new InterpreterError(
        `no value supplied for parameter '${source.param}'. Pass it through the interpreter's 'params' option.`,
      );
    }
    return supplied;
  }
}

function primaryOf(target: Target, stepId: string): SelectorCandidate {
  const primary = target.candidates[0];
  if (!primary) throw new InterpreterError(`step '${stepId}' has a target with no candidates`);
  return primary;
}
