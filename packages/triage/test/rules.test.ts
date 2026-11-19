// The richer classification result: stable rule codes, the retry hint,
// attribution carried through, and the tightened flake matching.

import { describe, it, expect } from 'vitest';
import {
  AssertionError,
  ExtractionError,
  PostconditionViolation,
  StepFailure,
  VaultSecretMissingError,
} from '@sfysh/runtime';
import type { Step } from '@sfysh/ir';
import { classify } from '../src/index.js';

function timeoutError(message: string): Error {
  const err = new Error(message);
  err.name = 'TimeoutError';
  return err;
}

const PLAYWRIGHT_CLICK_TIMEOUT =
  "locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByTestId('submit')\n";
const PLAYWRIGHT_GOTO_TIMEOUT =
  'page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "https://x.test/", waiting until "load"\n';

describe('classify: rule codes and the retry hint', () => {
  it.each([
    [
      'a missing vault secret',
      new VaultSecretMissingError('portal_pass'),
      'auth',
      'vault_secret_missing',
      false,
    ],
    [
      'an extraction failure',
      new ExtractionError("Column 'qty' not found"),
      'site',
      'extraction_failed',
      false,
    ],
    ['a failed assertion', new AssertionError('nope'), 'site', 'assertion_failed', false],
    ['a network error', new Error('net::ERR_NAME_NOT_RESOLVED'), 'flake', 'network_error', true],
    ['a DNS failure', new Error('getaddrinfo ENOTFOUND x.test'), 'flake', 'network_error', true],
    ['a dropped socket', new Error('socket hang up'), 'flake', 'network_error', true],
    ['an unrecognised error', new Error('something else'), 'unknown', 'no_rule', false],
  ])('%s', (_label, error, kind, rule, retryable) => {
    expect(classify({ error })).toMatchObject({ kind, rule, retryable });
  });

  it('reports a violated condition from the workflow with its step, phase and condition', () => {
    const error = new PostconditionViolation({
      stepId: 'click_003',
      phase: 'post',
      condition: { urlMatches: '/dashboard' },
      reason: 'did not match',
    });
    expect(classify({ error })).toEqual({
      kind: 'site',
      rule: 'condition_violated',
      reason: 'postcondition post violated on click_003',
      retryable: false,
      stepId: 'click_003',
      phase: 'post',
      condition: { urlMatches: '/dashboard' },
    });
  });

  it('reports a violated postcondition passed in by the caller', () => {
    const result = classify({
      error: null,
      postconditions: [
        { condition: { selectorVisible: '#a' }, status: 'held' },
        { condition: { urlMatches: '/done' }, status: 'violated', reason: 'no match' },
      ],
    });
    expect(result).toMatchObject({
      kind: 'site',
      rule: 'postcondition_violated',
      phase: 'post',
      condition: { urlMatches: '/done' },
      retryable: false,
    });
  });
});

describe('classify: timeouts are not all flakes', () => {
  const clickAttribution = {
    stepId: 'click_002',
    action: 'click',
    selector: { kind: 'testid' as const, value: 'submit' },
  };

  it('a timeout on an element action is a site failure worth one retry', () => {
    const result = classify({
      error: timeoutError(PLAYWRIGHT_CLICK_TIMEOUT),
      attribution: clickAttribution,
    });
    expect(result).toEqual({
      kind: 'site',
      rule: 'selector_timeout',
      reason: 'timed out waiting for testid selector "submit"',
      retryable: true,
      ...clickAttribution,
    });
  });

  it('a timeout on a navigate step is a flake', () => {
    const result = classify({
      error: timeoutError(PLAYWRIGHT_GOTO_TIMEOUT),
      attribution: { stepId: 'nav_001', action: 'navigate' },
    });
    expect(result).toMatchObject({
      kind: 'flake',
      rule: 'timeout',
      retryable: true,
      stepId: 'nav_001',
    });
  });

  it('without attribution, falls back to the wording of the backend message', () => {
    expect(classify({ error: timeoutError(PLAYWRIGHT_CLICK_TIMEOUT) })).toMatchObject({
      kind: 'site',
      rule: 'selector_timeout',
      reason: 'timed out waiting for an element',
    });
    expect(classify({ error: timeoutError(PLAYWRIGHT_GOTO_TIMEOUT) })).toMatchObject({
      kind: 'flake',
      rule: 'timeout',
    });
  });

  it('attribution wins over message wording', () => {
    // The message looks like an element wait, but the IR says this was a
    // wait step with no target.
    const result = classify({
      error: timeoutError(PLAYWRIGHT_CLICK_TIMEOUT),
      attribution: { stepId: 'wait_004', action: 'wait' },
    });
    expect(result).toMatchObject({ kind: 'flake', rule: 'timeout' });
  });

  it('reads the step and selector from a StepFailure wrapper', () => {
    const wrapped = new StepFailure(
      { id: 'fill_002', action: 'fill', selector: { kind: 'label', value: 'Email' } },
      timeoutError('locator.fill: Timeout 30000ms exceeded.'),
    );
    expect(classify({ error: wrapped })).toMatchObject({
      kind: 'site',
      rule: 'selector_timeout',
      stepId: 'fill_002',
      action: 'fill',
      selector: { kind: 'label', value: 'Email' },
    });
  });

  it('reads the step and selector from the IR step when that is all it has', () => {
    const step = {
      id: 'click_005',
      intent: 'Click.',
      action: 'click',
      target: {
        candidates: [
          { kind: 'css', value: '#go' },
          { kind: 'text', value: 'Go' },
        ],
      },
    } as unknown as Step;
    expect(classify({ error: timeoutError('Timeout 30000ms exceeded.'), step })).toMatchObject({
      kind: 'site',
      rule: 'selector_timeout',
      stepId: 'click_005',
      selector: { kind: 'css', value: '#go' },
    });
  });

  it('run and step time limits are flakes', () => {
    expect(classify({ error: new Error('run timed out after 60000ms') })).toMatchObject({
      kind: 'flake',
      rule: 'timeout',
    });
    expect(
      classify({
        error: new Error("step 'nav_001' did not finish within its timeoutMs of 4000ms"),
        attribution: { stepId: 'nav_001', action: 'navigate' },
      }),
    ).toMatchObject({ kind: 'flake', rule: 'timeout' });
  });
});

describe('classify: a number in a message is not a status code', () => {
  it.each([
    'Expected 500 rows but found 499',
    'Price 502.00 did not match',
    'Order #503 could not be opened',
    'Loaded 5000 items',
    'item 1500 of 2000',
  ])('does not call "%s" a flake', (message) => {
    expect(classify({ error: new Error(message) })).toMatchObject({
      kind: 'unknown',
      rule: 'no_rule',
    });
  });

  it.each([
    'Request failed with status code 503',
    'HTTP 502',
    'HTTP error: 500',
    'server error (504)',
    'response code 500',
    '502 Bad Gateway',
    '503 Service Unavailable',
    'Received 502 from upstream',
    'upstream returned 500',
    'status: 500',
  ])('calls "%s" a flake', (message) => {
    expect(classify({ error: new Error(message) })).toMatchObject({
      kind: 'flake',
      rule: 'http_server_error',
      retryable: true,
    });
  });

  it('does not treat a 4xx in a message as a flake', () => {
    expect(classify({ error: new Error('Request failed with status code 404') }).kind).toBe(
      'unknown',
    );
  });
});

describe('classify: response rules', () => {
  it('a 400 or 422 that says a field is required is a task change', () => {
    for (const status of [400, 422]) {
      expect(
        classify({ error: new Error("Field 'costCentre' is required"), response: { status } }),
      ).toMatchObject({ kind: 'task', rule: 'required_field_missing', retryable: false });
    }
    expect(
      classify({
        error: new Error('missing required parameter: region'),
        response: { status: 400 },
      }).kind,
    ).toBe('task');
  });

  it('a 400 that says something else is not a task change', () => {
    expect(
      classify({ error: new Error('Malformed JSON'), response: { status: 400 } }),
    ).toMatchObject({
      kind: 'unknown',
      rule: 'no_rule',
    });
  });

  it('a "required" message with no response is not a task change', () => {
    expect(classify({ error: new Error('Field is required') }).kind).toBe('unknown');
  });

  it('5xx and 401/403 keep their meaning and gain rule codes', () => {
    expect(classify({ error: null, response: { status: 503 } })).toMatchObject({
      kind: 'flake',
      rule: 'http_server_error',
      retryable: true,
    });
    expect(classify({ error: null, response: { status: 401 } })).toMatchObject({
      kind: 'auth',
      rule: 'http_auth',
      retryable: false,
    });
  });
});

describe('classify: attribution passes through', () => {
  it('copies what the caller gives it and never invents fields', () => {
    const bare = classify({ error: new Error('something else') });
    expect(Object.keys(bare).sort()).toEqual(['kind', 'reason', 'retryable', 'rule']);

    const attributed = classify({
      error: new Error('something else'),
      attribution: {
        stepId: 'extract_009',
        action: 'extract',
        selector: { kind: 'css', value: 'table' },
      },
    });
    expect(attributed).toEqual({
      kind: 'unknown',
      rule: 'no_rule',
      reason: 'no classification rule matched',
      retryable: false,
      stepId: 'extract_009',
      action: 'extract',
      selector: { kind: 'css', value: 'table' },
    });
  });

  it('accepts a RunResult.error object as the attribution', () => {
    // The shape run() produces: attribution fields alongside name and message.
    const runError = {
      name: 'TimeoutError',
      message: '[click_002] locator.click: Timeout 1500ms exceeded.',
      stepId: 'click_002',
      action: 'click',
      selector: { kind: 'testid' as const, value: 'nav-travel' },
    };
    const result = classify({
      error: timeoutError(PLAYWRIGHT_CLICK_TIMEOUT),
      attribution: runError,
    });
    expect(result).toMatchObject({ kind: 'site', rule: 'selector_timeout', stepId: 'click_002' });
    expect(result).not.toHaveProperty('name');
    expect(result).not.toHaveProperty('message');
  });
});

describe('classify: a selector that matched several elements', () => {
  // As Playwright reports it when a page gains a twin of the element.
  const STRICT =
    "locator.click: Error: strict mode violation: getByRole('button', { name: 'Apply' }) resolved to 2 elements:\n" +
    '    1) <button type="button" data-testid="apply-filter">Apply</button> aka getByTestId(\'apply-filter\')\n' +
    "    2) <button type=\"button\">Apply</button> aka getByRole('button', { name: 'Apply' }).nth(1)\n";

  it('is a site change, not retried, with the match count and the selector in the reason', () => {
    const result = classify({
      error: new Error(STRICT),
      attribution: {
        stepId: 'click_004',
        action: 'click',
        selector: { kind: 'role', value: "button[name='Apply']" },
      },
    });
    expect(result).toMatchObject({
      kind: 'site',
      rule: 'selector_ambiguous',
      retryable: false,
      stepId: 'click_004',
    });
    expect(result.reason).toBe(
      'role selector "button[name=\'Apply\']" matched 2 elements, so it no longer picks out one',
    );
  });

  it('is recognised from the message alone, without attribution', () => {
    const result = classify({
      error: new Error('strict mode violation: locator resolved to 3 elements'),
    });
    expect(result).toMatchObject({ kind: 'site', rule: 'selector_ambiguous' });
    expect(result.reason).toContain('3 elements');
  });

  it('is recognised through a StepFailure wrapper', () => {
    const step = {
      id: 'click_004',
      action: 'click',
      selector: { kind: 'role', value: "button[name='Apply']" },
    };
    const result = classify({ error: new StepFailure(step as never, new Error(STRICT)) });
    expect(result.rule).toBe('selector_ambiguous');
  });

  it('is not confused with an ordinary element timeout', () => {
    const result = classify({ error: timeoutError(PLAYWRIGHT_CLICK_TIMEOUT) });
    expect(result.rule).toBe('selector_timeout');
  });
});
