import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicProvider,
  CachedProvider,
  GeminiProvider,
  OllamaProvider,
  OpenAIProvider,
  ProviderError,
} from '../src/index.js';
import type { Completion, Provider } from '../src/index.js';
import { withDeadline } from '../src/deadline.js';

const msgs = [{ role: 'user' as const, content: 'Hi' }];

/** A call that never settles unless the signal it was given aborts. */
function hangsUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('sdk: request aborted')));
  });
}

/** A call that ignores its signal and never settles at all. */
function hangsForever(): Promise<never> {
  return new Promise(() => {});
}

async function rejection(promise: Promise<unknown>): Promise<ProviderError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProviderError);
  return error as ProviderError;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('withDeadline()', () => {
  it('passes the call through untouched when no deadline is set', async () => {
    const call = vi.fn().mockResolvedValue('ok');
    expect(await withDeadline('stub', undefined, call)).toBe('ok');
    expect(await withDeadline('stub', { maxTokens: 10 }, call)).toBe('ok');
    expect(call).toHaveBeenNthCalledWith(1, undefined);
    expect(call).toHaveBeenNthCalledWith(2, undefined);
  });

  it('returns the result when the call finishes inside the timeout', async () => {
    const call = vi.fn().mockResolvedValue('ok');
    expect(await withDeadline('stub', { timeoutMs: 1_000 }, call)).toBe('ok');
    expect(call.mock.calls[0]![0]).toBeInstanceOf(AbortSignal);
    // The timer is cleared, so nothing is left to fire later.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with a retryable timeout error and aborts the signal it handed out', async () => {
    let seen: AbortSignal | undefined;
    const pending = rejection(
      withDeadline('stub', { timeoutMs: 1_000 }, (signal) => {
        seen = signal;
        return hangsUntilAborted(signal);
      }),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    const error = await pending;

    expect(error.code).toBe('timeout');
    expect(error.retryable).toBe(true);
    expect(error.provider).toBe('stub');
    expect(error.message).toBe('stub request timed out after 1000ms');
    expect(seen?.aborted).toBe(true);
  });

  it('enforces the timeout even when the call ignores its signal', async () => {
    const pending = rejection(withDeadline('stub', { timeoutMs: 500 }, hangsForever));
    await vi.advanceTimersByTimeAsync(500);
    expect((await pending).code).toBe('timeout');
  });

  it('rejects with a non-retryable aborted error when the caller aborts', async () => {
    const controller = new AbortController();
    const pending = rejection(
      withDeadline('stub', { signal: controller.signal }, hangsUntilAborted),
    );

    const reason = new Error('user pressed ctrl-c');
    controller.abort(reason);
    const error = await pending;

    expect(error.code).toBe('aborted');
    expect(error.retryable).toBe(false);
    expect(error.cause).toBe(reason);
  });

  it('does not start the call when the signal is already aborted', async () => {
    const call = vi.fn().mockResolvedValue('ok');
    const error = await rejection(withDeadline('stub', { signal: AbortSignal.abort() }, call));
    expect(error.code).toBe('aborted');
    expect(call).not.toHaveBeenCalled();
  });

  it('reports aborted, not timeout, when the caller aborts before the timeout', async () => {
    const controller = new AbortController();
    const pending = rejection(
      withDeadline('stub', { signal: controller.signal, timeoutMs: 1_000 }, hangsUntilAborted),
    );

    await vi.advanceTimersByTimeAsync(400);
    controller.abort();

    expect((await pending).code).toBe('aborted');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports timeout when it elapses before the caller aborts', async () => {
    const controller = new AbortController();
    const pending = rejection(
      withDeadline('stub', { signal: controller.signal, timeoutMs: 1_000 }, hangsUntilAborted),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();

    expect((await pending).code).toBe('timeout');
  });

  it('rethrows an ordinary failure unchanged so the provider can classify it', async () => {
    const boom = new Error('401 unauthorised');
    const thrown = await withDeadline('stub', { timeoutMs: 1_000 }, () =>
      Promise.reject(boom),
    ).catch((e: unknown) => e);
    expect(thrown).toBe(boom);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects timeoutMs %s as a caller mistake',
    async (timeoutMs) => {
      const call = vi.fn().mockResolvedValue('ok');
      await expect(withDeadline('stub', { timeoutMs }, call)).rejects.toBeInstanceOf(RangeError);
      expect(call).not.toHaveBeenCalled();
    },
  );
});

type Hanging = ReturnType<typeof vi.fn>;

function anthropicHanging(): { provider: Provider; create: Hanging } {
  const create = vi.fn((_body: unknown, opts?: { signal?: AbortSignal }) =>
    hangsUntilAborted(opts?.signal),
  );
  const provider = new AnthropicProvider({ apiKey: 'test-key' });
  (provider as unknown as { client: { messages: { create: unknown } } }).client.messages.create =
    create;
  return { provider, create };
}

type ChatClient = { client: { chat: { completions: { create: unknown } } } };

function chatHanging(provider: Provider): { provider: Provider; create: Hanging } {
  const create = vi.fn((_body: unknown, opts?: { signal?: AbortSignal }) =>
    hangsUntilAborted(opts?.signal),
  );
  (provider as unknown as ChatClient).client.chat.completions.create = create;
  return { provider, create };
}

function geminiHanging(): { provider: Provider; create: Hanging } {
  const create = vi.fn((params: { config?: { abortSignal?: AbortSignal } }) =>
    hangsUntilAborted(params.config?.abortSignal),
  );
  const provider = new GeminiProvider({ apiKey: 'test-key' });
  (
    provider as unknown as { client: { models: { generateContent: unknown } } }
  ).client.models.generateContent = create;
  return { provider, create };
}

const hangingProviders: Array<[string, () => { provider: Provider; create: Hanging }]> = [
  ['anthropic', anthropicHanging],
  ['openai', () => chatHanging(new OpenAIProvider({ apiKey: 'test-key' }))],
  ['ollama', () => chatHanging(new OllamaProvider())],
  ['gemini', geminiHanging],
];

describe.each(hangingProviders)('%s provider deadlines', (name, make) => {
  it('rejects with a timeout error when the SDK call outlives timeoutMs', async () => {
    const { provider } = make();
    const pending = rejection(provider.complete(msgs, { timeoutMs: 2_000 }));

    await vi.advanceTimersByTimeAsync(2_000);
    const error = await pending;

    expect(error.code).toBe('timeout');
    expect(error.provider).toBe(name);
    expect(error.retryable).toBe(true);
  });

  it('cancels the SDK call when the caller aborts', async () => {
    const { provider } = make();
    const controller = new AbortController();
    const pending = rejection(provider.complete(msgs, { signal: controller.signal }));

    controller.abort();
    const error = await pending;

    expect(error.code).toBe('aborted');
    expect(error.provider).toBe(name);
    expect(error.retryable).toBe(false);
  });

  it('does not call the SDK when the signal is already aborted', async () => {
    const { provider, create } = make();
    const error = await rejection(provider.complete(msgs, { signal: AbortSignal.abort() }));
    expect(error.code).toBe('aborted');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('CachedProvider with deadlines', () => {
  const completion: Completion = {
    content: 'response',
    stopReason: 'end',
    usage: { inputTokens: 10, outputTokens: 5 },
    model: 'stub-model',
  };

  it('leaves timeoutMs and signal out of the cache key', async () => {
    const inner: Provider = { name: 'stub', complete: vi.fn().mockResolvedValue(completion) };
    const cached = new CachedProvider(inner);

    await cached.complete(msgs, { maxTokens: 100 });
    await cached.complete(msgs, { maxTokens: 100, timeoutMs: 5_000 });
    await cached.complete(msgs, { maxTokens: 100, signal: new AbortController().signal });

    expect(inner.complete).toHaveBeenCalledTimes(1);
    expect(cached.hits).toBe(2);
  });

  it('passes timeoutMs and signal through to the inner provider on a miss', async () => {
    const inner: Provider = { name: 'stub', complete: vi.fn().mockResolvedValue(completion) };
    const cached = new CachedProvider(inner);
    const options = { timeoutMs: 5_000, signal: new AbortController().signal };

    await cached.complete(msgs, options);

    expect(inner.complete).toHaveBeenCalledWith(msgs, options);
  });

  it('does not cache a timed-out call', async () => {
    const { provider } = anthropicHanging();
    const cached = new CachedProvider(provider);

    const pending = rejection(cached.complete(msgs, { timeoutMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await pending).code).toBe('timeout');
    expect(cached.misses).toBe(0);
    expect(cached.hits).toBe(0);
  });
});
