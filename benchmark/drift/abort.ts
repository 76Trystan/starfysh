// When `heal:drift` should stop early instead of finishing the run.
//
// A provider failure that a retry will not fix (a missing or wrong API
// key, an unknown model) fails every later model call the same way. Left
// alone, the run carries on for its full length, every model heal ends
// `not_healed`, and it exits 0 with results that look like a real run.
// That happened on 2026-11-24: the first full run on the held-out set h1
// went 17 minutes with no API key and made no model call at all.
//
// Retryable failures (rate limits, overload, timeouts) are left alone:
// `heal()` retries them, and one that still fails ends as `exhausted`, not
// `provider_error`. A spent budget ends as the `budget` cap, also not here.

import type { CaseRunResult } from './heal-run.js';

/** Why a run stopped early, as written to results.json. */
export interface RunAbort {
  caseId: string;
  run: number;
  /** The provider's error code, for example `auth` or `unknown`. */
  code: string;
  /** The provider's message, redacted by the healer. */
  message: string;
}

/**
 * The provider failure that should stop the run, or null to carry on.
 * A heal that stopped on `provider_error` means the provider failed in a
 * way `heal()` judged not worth retrying.
 */
export function providerFailure(result: CaseRunResult): RunAbort | null {
  for (const heal of result.heals) {
    if (heal.stopped !== 'provider_error') continue;
    // The last provider rejection is the one `heal()` stopped on.
    const failed = [...heal.attempts].reverse().find((a) => a.rejection?.stage === 'provider');
    return {
      caseId: result.caseId,
      run: result.run,
      code: failed?.rejection?.code ?? 'unknown',
      message: failed?.rejection?.message ?? 'no message recorded',
    };
  }
  return null;
}
