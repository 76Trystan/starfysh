import { describe, expect, it } from 'vitest';
import { providerFailure } from './abort.js';
import type { CaseRunResult, HealStepResult } from './heal-run.js';

const step = (over: Partial<HealStepResult>): HealStepResult => ({
  index: 0,
  trigger: 'failure',
  status: 'not_healed',
  attempts: [],
  ...over,
});

const result = (heals: HealStepResult[]): CaseRunResult =>
  ({
    caseId: 'bank-rename-statements-drop-testid',
    run: 2,
    heals,
  }) as CaseRunResult;

describe('providerFailure()', () => {
  it('stops on a heal that ended in a provider error, with its code and message', () => {
    const failed = step({
      stopped: 'provider_error',
      attempts: [
        {
          patchClass: 'selector',
          generated: 'provider_error',
          rejection: { stage: 'provider', code: 'auth', message: 'invalid x-api-key' },
        },
      ],
    });
    expect(providerFailure(result([failed]))).toEqual({
      caseId: 'bank-rename-statements-drop-testid',
      run: 2,
      code: 'auth',
      message: 'invalid x-api-key',
    });
  });

  it('reports the last provider rejection when there were several', () => {
    const failed = step({
      stopped: 'provider_error',
      attempts: [
        {
          patchClass: 'selector',
          generated: 'provider_error',
          rejection: { stage: 'provider', code: 'rate_limit', message: 'slow down' },
        },
        {
          patchClass: 'selector',
          generated: 'provider_error',
          rejection: { stage: 'provider', code: 'unknown', message: 'no key' },
        },
      ],
    });
    expect(providerFailure(result([failed]))?.code).toBe('unknown');
  });

  it('carries on after a retryable failure that ended as exhausted', () => {
    const exhausted = step({
      stopped: 'exhausted',
      attempts: [
        {
          patchClass: 'selector',
          generated: 'provider_error',
          rejection: { stage: 'provider', code: 'server_error', message: 'busy' },
        },
      ],
    });
    expect(providerFailure(result([exhausted]))).toBeNull();
  });

  it('carries on after a refusal, a budget cap, or a heal that worked', () => {
    expect(providerFailure(result([step({ stopped: 'exhausted' })]))).toBeNull();
    expect(providerFailure(result([step({ status: 'capped', stopped: 'budget' })]))).toBeNull();
    expect(providerFailure(result([step({ status: 'decided' })]))).toBeNull();
    expect(providerFailure(result([]))).toBeNull();
  });
});
