// Generated code wraps step failures in a StepFailure carrier. The
// classifier must see through it, so a caller that passes the wrapper gets
// the same answer as one that passes the original error.

import { describe, it, expect } from 'vitest';
import {
  AssertionError,
  ExtractionError,
  PostconditionViolation,
  StepFailure,
  VaultSecretMissingError,
} from '@sfysh/runtime';
import { classify } from '../src/index.js';

const info = { id: 'click_003', action: 'click' };

describe('classify: StepFailure wrapper', () => {
  it.each([
    ['VaultSecretMissingError', new VaultSecretMissingError('portal_pass'), 'auth'],
    ['ExtractionError', new ExtractionError('column missing'), 'site'],
    ['AssertionError', new AssertionError('nope'), 'site'],
    [
      'PostconditionViolation',
      new PostconditionViolation({
        stepId: 'click_003',
        phase: 'post',
        condition: { urlMatches: '/dashboard' },
        reason: 'did not match',
      }),
      'site',
    ],
    ['network error', new Error('net::ERR_CONNECTION_RESET'), 'flake'],
    ['unrecognised error', new Error('something else'), 'unknown'],
  ])('classifies a wrapped %s the same as the bare error', (_label, error, kind) => {
    const bare = classify({ error });
    const wrapped = classify({ error: new StepFailure(info, error) });
    expect(bare.kind).toBe(kind);
    // Same verdict either way. The wrapper also tells triage which step it was.
    expect(wrapped).toMatchObject({
      kind: bare.kind,
      rule: bare.rule,
      reason: bare.reason,
      retryable: bare.retryable,
    });
    expect(wrapped.stepId).toBe('click_003');
    expect(wrapped.action).toBe('click');
  });
});
