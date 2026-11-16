import { ProviderError, type CompleteOptions } from './types.js';

/**
 * Run one provider call under the caller's `signal` and `timeoutMs`.
 *
 * `call` receives a signal to hand to the vendor SDK, or `undefined` when
 * the caller set neither option, in which case this is a plain passthrough.
 * The signal fires when the caller aborts or the timeout elapses, whichever
 * comes first.
 *
 * The call is also raced against that signal here. A backend that ignores
 * the signal it was given (a local server behind a proxy, a custom
 * `Provider` in a test) would otherwise hang the caller for as long as it
 * liked, and a timeout that only works when the other side cooperates is
 * not a timeout.
 *
 * A timeout rejects with `ProviderError` code `timeout`; a caller abort
 * rejects with code `aborted`. Any other failure is rethrown as it was, so
 * each provider's own error mapping still applies.
 */
export async function withDeadline<T>(
  provider: string,
  options: CompleteOptions | undefined,
  call: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  const callerSignal = options?.signal;
  const timeoutMs = options?.timeoutMs;

  if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new RangeError(`timeoutMs must be a positive, finite number; got ${timeoutMs}`);
  }
  if (callerSignal === undefined && timeoutMs === undefined) {
    return call(undefined);
  }
  if (callerSignal?.aborted) {
    throw abortedError(provider, callerSignal);
  }

  const controller = new AbortController();
  let timedOut = false;

  const onCallerAbort = () => controller.abort();
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);

  const failure = (): ProviderError =>
    timedOut ? timeoutError(provider, timeoutMs!) : abortedError(provider, callerSignal);

  const cancelled = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(failure()), { once: true });
  });

  const pending = call(controller.signal);
  // If the race is lost, the call is left to settle on its own. Most SDKs
  // reject it with their own abort error, which nobody is waiting for.
  pending.catch(() => {});

  try {
    return await Promise.race([pending, cancelled]);
  } catch (error) {
    // The SDK's abort error can win the race against `cancelled`. Report
    // the reason the signal fired, not the SDK's wording of it.
    if (controller.signal.aborted && !(error instanceof ProviderError)) throw failure();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

function timeoutError(provider: string, timeoutMs: number): ProviderError {
  return new ProviderError(`${provider} request timed out after ${timeoutMs}ms`, {
    code: 'timeout',
    provider,
  });
}

function abortedError(provider: string, signal: AbortSignal | undefined): ProviderError {
  return new ProviderError(`${provider} request was aborted by the caller`, {
    code: 'aborted',
    provider,
    cause: signal?.reason,
  });
}
