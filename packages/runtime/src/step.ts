// Step attribution. Generated code wraps every IR step in `step(...)` so
// that any failure inside it, not only a violated pre or post condition,
// can be traced back to the IR step that was running and the selector it
// was using. The healer needs both to know which step to patch.

import type { Condition, SelectorCandidate } from '@sfysh/ir';
import type { WorkflowContext } from './context.js';
import { PostconditionViolation } from './conditions.js';

/** What generated code tells the runtime about the step it is entering. */
export interface StepInfo {
  /** IR step id. */
  id: string;
  /** IR action kind (`navigate`, `click`, `fill`, and so on). */
  action: string;
  /**
   * The selector candidate the step is using. Present for steps that act on
   * an element. Compiled code always uses the first candidate today.
   */
  selector?: SelectorCandidate;
}

/**
 * Thrown by `step()` when the wrapped body fails. It is a carrier, not a
 * new kind of failure: `cause` holds the original error, and callers that
 * classify failures should look at the cause. `run()` and the verifier
 * unwrap it, so most code never sees this class.
 */
export class StepFailure extends Error {
  readonly step: StepInfo;

  constructor(step: StepInfo, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'StepFailure';
    this.step = step;
  }
}

/**
 * Run one IR step. Returns whatever the body returns. If the body throws,
 * the error is wrapped in a `StepFailure` naming this step. When steps are
 * nested (a click inside a guard inside a loop), the innermost step keeps
 * the attribution, because that is the one that actually failed.
 */
export async function step<T>(
  _ctx: WorkflowContext,
  info: StepInfo,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof StepFailure) throw err;
    throw new StepFailure(info, err);
  }
}

/** Where and why a run failed, in a form that is safe to log and serialise. */
export interface FailureAttribution {
  /** IR step that was running. Undefined when the failure happened outside any step. */
  stepId?: string;
  /** Action kind of that step. */
  action?: string;
  /** Selector candidate the step was using, if it had a target. */
  selector?: SelectorCandidate;
  /** Set when a pre or post condition was violated. */
  phase?: 'pre' | 'post';
  /** The violated condition. Set alongside `phase`. */
  condition?: Condition;
  /** Why the condition did not hold. Set alongside `phase`. */
  reason?: string;
}

export interface DescribedFailure {
  /** Name of the original error (`TimeoutError`, `ExtractionError`, ...). */
  name: string;
  /** Message of the original error with secrets redacted. */
  message: string;
  /** The original thrown value, with any `StepFailure` wrapper removed. Not redacted. */
  cause: unknown;
  attribution: FailureAttribution;
}

// Terminal escape sequences: CSI (colours, cursor movement) and OSC
// (hyperlinks, window titles). Playwright colours parts of its error
// messages with these even when the output is not going to a terminal.
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * Turn a thrown value into the report shape shared by `run()` and the
 * verifier. Unwraps `StepFailure`, pulls condition details off a
 * `PostconditionViolation`, strips terminal colour codes from the message
 * and reason, and passes every string through `ctx.redact`.
 *
 * Colour codes are stripped before redaction, not after. A browser backend
 * that colours part of a quoted value would otherwise split a secret with
 * an escape sequence and the redactor would not recognise it.
 */
export function describeFailure(ctx: WorkflowContext, err: unknown): DescribedFailure {
  const wrapped = err instanceof StepFailure ? err : undefined;
  const cause: unknown = wrapped ? wrapped.cause : err;
  const attribution: FailureAttribution = {};

  if (wrapped) {
    attribution.stepId = wrapped.step.id;
    attribution.action = wrapped.step.action;
    if (wrapped.step.selector) {
      attribution.selector = {
        kind: wrapped.step.selector.kind,
        value: ctx.redact(wrapped.step.selector.value),
      };
    }
  }

  if (cause instanceof PostconditionViolation) {
    // A violation names its own step. Inside generated code that is always
    // the wrapping step; for hand-written workflows it is the only source.
    attribution.stepId = cause.stepId;
    attribution.phase = cause.phase;
    attribution.condition = redactCondition(ctx, cause.condition);
    attribution.reason = ctx.redact(stripAnsi(cause.reason));
  }

  const rawMessage = cause instanceof Error ? cause.message : String(cause);
  const prefix =
    attribution.stepId !== undefined && !(cause instanceof PostconditionViolation)
      ? `[${attribution.stepId}] `
      : '';

  return {
    name: cause instanceof Error ? cause.name : 'Error',
    message: ctx.redact(prefix + stripAnsi(rawMessage)),
    cause,
    attribution,
  };
}

function redactCondition(ctx: WorkflowContext, condition: Condition): Condition {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(condition)) {
    out[key] = typeof value === 'string' ? ctx.redact(value) : value;
  }
  return out as Condition;
}
