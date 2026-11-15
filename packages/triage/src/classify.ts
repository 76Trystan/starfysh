import type { SelectorCandidate } from '@sfysh/ir';
import {
  AssertionError,
  ExtractionError,
  PostconditionViolation,
  StepFailure,
  VaultSecretMissingError,
} from '@sfysh/runtime';
import type { FailureAttribution } from '@sfysh/runtime';
import type { ClassifyInput, ClassifyResult, FailureKind, TriageRule } from './types.js';

// The patterns below are built from strings, with word boundaries written
// as the WB constant, so that no regex escape in this file depends on how
// an editor or tool treats a backslash followed by a letter.
const WB = String.fromCharCode(92) + 'b';
const re = (source: string): RegExp => new RegExp(source, 'i');

// Network-level failures: the request never got a usable answer.
const NETWORK_ERROR = re(
  ['net::ERR_', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']
    .map((code) => (code.endsWith('_') ? code : WB + code + WB))
    .concat('socket hang up')
    .join('|'),
);

// A 5xx status quoted in an error message. The number has to sit next to a
// word that makes it a status code. A bare "500" is not enough: it is just
// as likely to be a row count or a price.
const SERVER_ERROR_IN_MESSAGE = re(
  WB +
    '(?:status(?: ?code)?|http(?: ?error)?|response(?: ?code)?|server ?error)' +
    WB +
    '[^0-9]{0,12}' +
    WB +
    '5[0-9][0-9]' +
    WB +
    '|' +
    WB +
    '5[0-9][0-9] +(?:internal server error|bad gateway|service unavailable|gateway time-?out)' +
    WB +
    '|' +
    WB +
    '(?:received|returned|got|responded with) (?:an? )?(?:http )?5[0-9][0-9]' +
    WB,
);

const TIMEOUT = re(
  WB + 'timed? ?out' + WB + '|' + WB + 'timeout' + WB + '|' + WB + 'timeoutMs' + WB,
);

// Text a browser backend puts in a timeout message when it was waiting for
// an element, as opposed to a navigation.
const WAITING_FOR_ELEMENT = re(
  'waiting for (?:locator|getBy|selector|element)|locator[.][a-z]+: Timeout',
);

const REQUIRED_FIELD = re(
  WB + 'required' + WB + '|' + WB + 'missing (?:required )?(?:field|parameter|property)' + WB,
);

/** Actions that operate on an element found by a selector. */
const ELEMENT_ACTIONS = new Set(['click', 'fill', 'extract']);

/**
 * Deterministic triage classifier. Pure function; no I/O, no model call.
 *
 * Rules run in a fixed order and the first match wins:
 *
 *  1. A postcondition result passed by the caller is violated: `site`.
 *  2. Missing vault secret: `auth`.
 *  3. A pre or post condition failed in the workflow: `site`.
 *  4. Extraction failed: `site`.
 *  5. An assertion failed: `site`.
 *  6. Response says a required field is missing (400 or 422): `task`.
 *  7. Response is 5xx: `flake`.
 *  8. Response is 401 or 403: `auth`.
 *  9. Network-level error: `flake`.
 * 10. A 5xx status quoted in the error message: `flake`.
 * 11. Timeout while waiting for an element: `site`, retryable.
 * 12. Any other timeout: `flake`.
 * 13. Nothing matched: `unknown`.
 *
 * A violated postcondition is the strongest single signal of site drift and
 * runs before any instanceof check, so a `PostconditionViolation` thrown
 * alongside a passing-but-stale postcondition set still classifies as `site`.
 */
export function classify(input: ClassifyInput): ClassifyResult {
  const { postconditions, response } = input;
  // Generated code wraps step failures in a StepFailure carrier. run() and
  // the verifier unwrap it, but a caller that executes a workflow function
  // directly may pass the wrapper, so look through it here as well.
  const wrapper = input.error instanceof StepFailure ? input.error : undefined;
  const error: unknown = wrapper ? wrapper.cause : input.error;
  const where = locate(input, wrapper, error);

  const result = (
    kind: FailureKind,
    rule: TriageRule,
    reason: string,
    retryable: boolean = kind === 'flake',
  ): ClassifyResult => ({ kind, rule, reason, retryable, ...where });

  const violated = postconditions?.find((p) => p.status === 'violated');
  if (violated) {
    return {
      ...result('site', 'postcondition_violated', 'postcondition violated'),
      phase: where.phase ?? 'post',
      condition: where.condition ?? violated.condition,
    };
  }

  if (error instanceof VaultSecretMissingError) {
    return result('auth', 'vault_secret_missing', `missing vault secret: ${error.secretName}`);
  }
  if (error instanceof PostconditionViolation) {
    return result(
      'site',
      'condition_violated',
      `postcondition ${error.phase} violated on ${error.stepId}`,
    );
  }
  if (error instanceof ExtractionError) {
    return result('site', 'extraction_failed', 'extraction target missing');
  }
  if (error instanceof AssertionError) {
    return result('site', 'assertion_failed', 'assertion failed');
  }

  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';

  if (response) {
    if ((response.status === 400 || response.status === 422) && REQUIRED_FIELD.test(message)) {
      return result(
        'task',
        'required_field_missing',
        `HTTP ${response.status}: a required field is missing`,
      );
    }
    if (response.status >= 500) {
      return result('flake', 'http_server_error', `HTTP ${response.status}`);
    }
    if (response.status === 401 || response.status === 403) {
      return result('auth', 'http_auth', `HTTP ${response.status}`);
    }
  }

  if (NETWORK_ERROR.test(message)) {
    return result('flake', 'network_error', 'transient network error');
  }
  if (SERVER_ERROR_IN_MESSAGE.test(message)) {
    return result('flake', 'http_server_error', 'server error reported in the error message');
  }

  if (TIMEOUT.test(message)) {
    // The same word covers two different situations. A page that is slow to
    // load is a flake. An element that never appears, on a page that did
    // load, is what a changed selector looks like. Treating the second as a
    // flake would retry it forever and the healer would never see it.
    if (waitedForElement(where, message)) {
      return result(
        'site',
        'selector_timeout',
        where.selector
          ? `timed out waiting for ${where.selector.kind} selector ${JSON.stringify(where.selector.value)}`
          : 'timed out waiting for an element',
        true,
      );
    }
    return result('flake', 'timeout', 'timed out');
  }

  return result('unknown', 'no_rule', 'no classification rule matched');
}

type Where = Pick<ClassifyResult, 'stepId' | 'action' | 'selector' | 'phase' | 'condition'>;

/**
 * Work out where the failure happened from whichever source has it: the
 * attribution the caller passed, the StepFailure wrapper, a
 * PostconditionViolation, or the IR step.
 */
function locate(input: ClassifyInput, wrapper: StepFailure | undefined, error: unknown): Where {
  const given: FailureAttribution = input.attribution ?? {};
  const step = input.step as
    { id?: string; action?: string; target?: { candidates: SelectorCandidate[] } } | undefined;
  const violation = error instanceof PostconditionViolation ? error : undefined;

  const stepId = given.stepId ?? wrapper?.step.id ?? violation?.stepId ?? step?.id;
  const action = given.action ?? wrapper?.step.action ?? step?.action;
  const selector = given.selector ?? wrapper?.step.selector ?? step?.target?.candidates[0];
  const phase = given.phase ?? violation?.phase;
  const condition = given.condition ?? violation?.condition;

  return {
    ...(stepId !== undefined ? { stepId } : {}),
    ...(action !== undefined ? { action } : {}),
    ...(selector !== undefined ? { selector: { kind: selector.kind, value: selector.value } } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(condition !== undefined ? { condition } : {}),
  };
}

function waitedForElement(where: Where, message: string): boolean {
  if (where.action !== undefined) {
    // Attribution is the better signal when present: it comes from the IR,
    // not from the wording of a backend's error message.
    return ELEMENT_ACTIONS.has(where.action) && where.selector !== undefined;
  }
  return WAITING_FOR_ELEMENT.test(message);
}
