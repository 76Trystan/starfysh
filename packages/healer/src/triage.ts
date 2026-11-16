// Triage wiring: decide what happens to a failed replay before any model is
// involved.
//
// The classification itself is `classify()` from `@sfysh/triage`, a pure
// function over the error. This file adds the three things only a caller
// that holds the replay can do:
//
// 1. Feed the classifier everything a `ReplayOutcome` carries.
// 2. Look at the page snapshot for the one browser signal the classifier
//    cannot see: the page asking for a field the workflow did not fill.
// 3. Retry once when triage says a retry is worth it, and route on what
//    the second attempt shows.
//
// No model is called here. Most failures should end here.

import { classify } from '@sfysh/triage';
import type { ClassifyResult, FailureKind, TriageRule } from '@sfysh/triage';
import type { ReplayOutcome } from '@sfysh/verifier';

/**
 * Rule code for the browser `task` rule, which lives here and not in
 * `@sfysh/triage` because it needs the page snapshot.
 */
export const PAGE_REQUIRES_FIELD = 'page_requires_field';

/** A triage result that may carry the healer's own browser `task` rule. */
export interface HealerTriage extends Omit<ClassifyResult, 'rule'> {
  rule: TriageRule | typeof PAGE_REQUIRES_FIELD;
}

/**
 * Where a failure goes next.
 *
 * - `backoff`: transient. Retry later with backoff. No model.
 * - `reauthenticate`: re-run the login sub-workflow. No model.
 * - `heal`: the site changed. Wake the healer for the failed step.
 * - `draft_for_approval`: the task changed. The healer may draft a change,
 *   but it must not be accepted without a person approving it.
 * - `escalate`: nothing matched. Hand it to a person.
 */
export type HealRoute = 'backoff' | 'reauthenticate' | 'heal' | 'draft_for_approval' | 'escalate';

const ROUTES: Record<FailureKind, HealRoute> = {
  flake: 'backoff',
  auth: 'reauthenticate',
  site: 'heal',
  task: 'draft_for_approval',
  unknown: 'escalate',
};

/** The route for a failure kind. */
export function routeFor(kind: FailureKind): HealRoute {
  return ROUTES[kind];
}

// Wording a page uses when it rejects a form because a field was left
// empty. Each alternative is a validation message, not a label: "Email is
// required" matches, a "* Required" legend or "Required fields are marked"
// does not. Built from strings so no escape in this file depends on how a
// tool treats a backslash followed by a letter.
const WB = String.fromCharCode(92) + 'b';
const REQUIRED_FIELD_MESSAGE = new RegExp(
  [
    WB + 'is (?:a )?required' + WB + '(?! (?:for|to|by|when|if|before|in order)' + WB + ')',
    WB + 'field is required' + WB,
    WB + "can(?:no|')?t be (?:blank|empty|left blank|left empty)" + WB,
    WB + 'must not be (?:blank|empty)' + WB,
    WB + 'please fill (?:out|in) this field' + WB,
    WB + 'missing (?:a )?required (?:field|value|answer)' + WB,
  ].join('|'),
  'i',
);

// Site failures the page-requires-field rule may reinterpret. An extraction
// failure is left alone: the workflow got past its forms and failed reading
// a result, so a "required" message on that page is not why it failed.
const FORM_FAILURE_RULES = new Set<string>([
  'postcondition_violated',
  'condition_violated',
  'assertion_failed',
  'selector_timeout',
]);

/**
 * True when the snapshot shows the page asking for a field that was left
 * empty. A text heuristic over the accessibility tree, and deliberately a
 * narrow one. When it is wrong in the direction of a false match, a
 * healable failure is sent for human approval, which is slower but safe.
 */
export function pageRequiresField(snapshotText: string): boolean {
  return REQUIRED_FIELD_MESSAGE.test(snapshotText);
}

/**
 * Classify one failed replay.
 *
 * Passes the raw error, the attribution and the postcondition results to
 * `classify()`. Then applies the browser `task` rule: a failure that would
 * be `site`, on a page that is asking for a field the workflow left empty,
 * is a `task` change. A new selector cannot fix it, because the workflow
 * has no value to put in the field.
 *
 * The raw error (`outcome.error.cause`) only exists in the process that
 * ran the replay. For an outcome that was serialised and read back, the
 * classifier is given the redacted name and message instead. Rules that
 * depend on the error's class do not fire then; the attribution and the
 * postcondition results still do most of the work.
 *
 * Throws `TypeError` when the outcome did not fail.
 */
export function classifyOutcome(outcome: ReplayOutcome): HealerTriage {
  const error = outcome.error;
  if (outcome.status !== 'failed' || error === undefined) {
    throw new TypeError('classifyOutcome() needs a failed replay outcome.');
  }

  const triage = classify({
    error: error.cause !== undefined ? error.cause : rebuildError(error),
    attribution: error,
    postconditions: outcome.postconditions,
  });

  if (
    triage.kind === 'site' &&
    FORM_FAILURE_RULES.has(triage.rule) &&
    outcome.snapshot !== undefined &&
    pageRequiresField(outcome.snapshot.text)
  ) {
    return {
      ...triage,
      kind: 'task',
      rule: PAGE_REQUIRES_FIELD,
      // Fixed wording. The page's own message is untrusted text and is not
      // copied into a field that ends up in logs.
      reason: 'the page reports a required field that the workflow did not fill',
      retryable: false,
    };
  }

  return triage;
}

function rebuildError(error: { name: string; message: string }): Error {
  const rebuilt = new Error(error.message);
  rebuilt.name = error.name;
  return rebuilt;
}

export type TriageDecision =
  | {
      /** The retry passed. Nothing is wrong with the workflow; no model is needed. */
      recovered: true;
      /** The passing retry. */
      outcome: ReplayOutcome;
      /** What the first failure looked like, for the record. */
      firstTriage: HealerTriage;
    }
  | {
      recovered: false;
      route: HealRoute;
      /** Classification of the failure the route is based on. */
      triage: HealerTriage;
      /** The failure the route is based on: the retry's if one ran, else the original. */
      outcome: ReplayOutcome;
      /** True when a retry ran and failed as well. */
      retried: boolean;
      /** Classification of the first failure. Present only when a retry ran. */
      firstTriage?: HealerTriage;
    };

export interface TriageOptions {
  /**
   * Run the workflow once more and return the outcome. Called at most
   * once, and only when triage says a retry is worth trying. Leave it out
   * to route on the first failure alone.
   *
   * If it rejects, `triageFailure` rejects with the same error.
   */
  retry?: () => Promise<ReplayOutcome>;
}

/**
 * Decide what happens to a failed replay.
 *
 * Triage marks two kinds of failure as worth one plain retry: every flake,
 * and a timeout waiting for an element, where one retry separates a slow
 * page from a changed one. When `retry` is given and the failure is one of
 * those, it runs once:
 *
 * - The retry passes: the failure was transient. `recovered` is true and
 *   the healer is not woken.
 * - The retry fails: the second failure is classified and routed. It is
 *   not retried again, whatever it is. A flake that survives a retry is
 *   routed to `backoff`, which is the scheduler's job, not the healer's.
 *
 * The second failure is the one routed on because it is the fresher
 * evidence, and its snapshot is the one a heal would work from.
 */
export async function triageFailure(
  outcome: ReplayOutcome,
  options: TriageOptions = {},
): Promise<TriageDecision> {
  const firstTriage = classifyOutcome(outcome);

  if (!firstTriage.retryable || options.retry === undefined) {
    return {
      recovered: false,
      route: routeFor(firstTriage.kind),
      triage: firstTriage,
      outcome,
      retried: false,
    };
  }

  const second = await options.retry();
  if (second.status === 'ok') {
    return { recovered: true, outcome: second, firstTriage };
  }

  const triage = classifyOutcome(second);
  return {
    recovered: false,
    route: routeFor(triage.kind),
    triage,
    outcome: second,
    retried: true,
    firstTriage,
  };
}
