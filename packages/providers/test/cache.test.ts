import { describe, it, expect, vi } from 'vitest';
import {
  AnthropicProvider,
  CachedProvider,
  cacheKey,
  canonicalRequest,
  GeminiProvider,
  MemoryCacheStore,
  OllamaProvider,
  OpenAIProvider,
  RedactingProvider,
} from '../src/index.js';
import type { CacheEntry, Provider, Completion, Message } from '../src/index.js';

function stubProvider(
  result?: Partial<Completion>,
  identity: { name?: string; model?: string | undefined } = {},
): Provider {
  return {
    name: identity.name ?? 'stub',
    model: 'model' in identity ? identity.model : 'stub-model',
    complete: vi.fn().mockResolvedValue({
      content: result?.content ?? 'response',
      stopReason: result?.stopReason ?? 'end',
      usage: result?.usage ?? { inputTokens: 10, outputTokens: 5 },
      model: result?.model ?? 'stub-model',
    }),
  };
}

const msgs: Message[] = [{ role: 'user', content: 'Hello' }];

const completion: Completion = {
  content: 'cached',
  stopReason: 'end',
  usage: { inputTokens: 1, outputTokens: 1 },
  model: 'm',
};

describe('CachedProvider', () => {
  it('delegates to inner provider on cache miss', async () => {
    const inner = stubProvider();
    const cached = new CachedProvider(inner);

    const result = await cached.complete(msgs);

    expect(inner.complete).toHaveBeenCalledWith(msgs, undefined);
    expect(result.content).toBe('response');
  });

  it('returns cached result on cache hit without calling inner', async () => {
    const inner = stubProvider();
    const cached = new CachedProvider(inner);

    await cached.complete(msgs);
    const result = await cached.complete(msgs);

    expect(inner.complete).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('response');
  });

  it('tracks hits and misses', async () => {
    const inner = stubProvider();
    const cached = new CachedProvider(inner);

    await cached.complete(msgs);
    await cached.complete(msgs);
    await cached.complete(msgs);

    expect(cached.hits).toBe(2);
    expect(cached.misses).toBe(1);
  });

  it('treats different messages as different cache keys', async () => {
    const inner = stubProvider();
    const cached = new CachedProvider(inner);

    await cached.complete([{ role: 'user', content: 'Hello' }]);
    await cached.complete([{ role: 'user', content: 'Goodbye' }]);

    expect(inner.complete).toHaveBeenCalledTimes(2);
    expect(cached.misses).toBe(2);
  });

  it('treats a different role with the same content as a different request', async () => {
    const inner = stubProvider();
    const cached = new CachedProvider(inner);

    await cached.complete([{ role: 'user', content: 'Hello' }]);
    await cached.complete([{ role: 'system', content: 'Hello' }]);

    expect(inner.complete).toHaveBeenCalledTimes(2);
  });

  it('treats different options as different cache keys', async () => {
    const inner = stubProvider();
    const cached = new CachedProvider(inner);

    await cached.complete(msgs, { maxTokens: 100 });
    await cached.complete(msgs, { maxTokens: 200 });
    await cached.complete(msgs, { maxTokens: 200, stop: ['x'] });

    expect(inner.complete).toHaveBeenCalledTimes(3);
  });

  it('treats identical options as the same cache key', async () => {
    const inner = stubProvider();
    const cached = new CachedProvider(inner);

    await cached.complete(msgs, { maxTokens: 100, stop: ['x'] });
    await cached.complete(msgs, { maxTokens: 100, stop: ['x'] });

    expect(inner.complete).toHaveBeenCalledTimes(1);
    expect(cached.hits).toBe(1);
  });

  it('ignores the deadline and signal when keying', async () => {
    const inner = stubProvider();
    const cached = new CachedProvider(inner);

    await cached.complete(msgs, { maxTokens: 100, timeoutMs: 1000 });
    await cached.complete(msgs, {
      maxTokens: 100,
      timeoutMs: 5000,
      signal: new AbortController().signal,
    });

    expect(inner.complete).toHaveBeenCalledTimes(1);
  });

  it('does not share entries between models, even through one store', async () => {
    const store = new MemoryCacheStore();
    const a = stubProvider({ content: 'from a' }, { model: 'model-a' });
    const b = stubProvider({ content: 'from b' }, { model: 'model-b' });

    await new CachedProvider(a, { store }).complete(msgs);
    const result = await new CachedProvider(b, { store }).complete(msgs);

    expect(result.content).toBe('from b');
    expect(b.complete).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(2);
  });

  it('does not share entries between providers with the same model name', async () => {
    const store = new MemoryCacheStore();
    const a = stubProvider({ content: 'from a' }, { name: 'openai', model: 'shared' });
    const b = stubProvider({ content: 'from b' }, { name: 'ollama', model: 'shared' });

    await new CachedProvider(a, { store }).complete(msgs);
    const result = await new CachedProvider(b, { store }).complete(msgs);

    expect(result.content).toBe('from b');
  });

  it('refuses to be built when it cannot learn the model', () => {
    expect(() => new CachedProvider(stubProvider({}, { model: undefined }))).toThrow(TypeError);
    expect(() => new CachedProvider(stubProvider({}, { model: '' }))).toThrow(TypeError);
  });

  it('takes the model from the config when the provider has none', async () => {
    const cached = new CachedProvider(stubProvider({}, { model: undefined }), { model: 'x' });
    expect(cached.model).toBe('x');
    await cached.complete(msgs);
    expect(cached.misses).toBe(1);
  });

  it("prefers the provider's model over the config", () => {
    const cached = new CachedProvider(stubProvider({}, { model: 'real' }), { model: 'other' });
    expect(cached.model).toBe('real');
  });

  it('keys on a 256-bit SHA-256 digest of the canonical request', async () => {
    const store = new MemoryCacheStore();
    const set = vi.spyOn(store, 'set');
    await new CachedProvider(stubProvider(), { store }).complete(msgs, { maxTokens: 10 });

    const [key, entry] = set.mock.calls[0]!;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.request).toBe(canonicalRequest('stub', 'stub-model', msgs, { maxTokens: 10 }));
    expect(key).toBe(cacheKey(entry.request));
  });

  it('serves a hit only when the stored request matches, and counts a mismatch', async () => {
    const store = new MemoryCacheStore();
    const inner = stubProvider({ content: 'fresh' });
    const cached = new CachedProvider(inner, { store });
    const request = canonicalRequest('stub', 'stub-model', msgs);
    // An entry under the right key that answers a different request: a
    // tampered store, or a collision.
    store.set(cacheKey(request), { request: request.replace('Hello', 'Other'), completion });

    const result = await cached.complete(msgs);

    expect(result.content).toBe('fresh');
    expect(cached.hits).toBe(0);
    expect(cached.misses).toBe(1);
    expect(cached.mismatches).toBe(1);
    expect(store.get(cacheKey(request))?.request).toBe(request);
  });

  it('leaves extra message properties out of the key', async () => {
    const inner = stubProvider();
    const cached = new CachedProvider(inner);

    await cached.complete(msgs);
    await cached.complete([{ role: 'user', content: 'Hello', extra: 1 } as unknown as Message]);

    expect(inner.complete).toHaveBeenCalledTimes(1);
  });

  it('exposes the inner provider name', () => {
    const inner = stubProvider();
    const cached = new CachedProvider(inner);
    expect(cached.name).toBe('stub');
  });

  it('accepts a custom cache store', async () => {
    const store = new MemoryCacheStore();
    const inner = stubProvider();
    const cached = new CachedProvider(inner, { store });

    await cached.complete(msgs);
    expect(store.size).toBe(1);
  });

  it('propagates errors from the inner provider and caches nothing', async () => {
    const store = new MemoryCacheStore();
    const inner: Provider = {
      name: 'failing',
      model: 'm',
      complete: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const cached = new CachedProvider(inner, { store });

    await expect(cached.complete(msgs)).rejects.toThrow('boom');
    expect(cached.misses).toBe(0);
    expect(cached.hits).toBe(0);
    expect(store.size).toBe(0);
  });
});

describe('provider models', () => {
  it('every vendor provider reports its configured model', () => {
    expect(new AnthropicProvider({ apiKey: 'k', model: 'a-model' }).model).toBe('a-model');
    expect(new OpenAIProvider({ apiKey: 'k', model: 'o-model' }).model).toBe('o-model');
    expect(new GeminiProvider({ apiKey: 'k', model: 'g-model' }).model).toBe('g-model');
    expect(new OllamaProvider({ model: 'l-model' }).model).toBe('l-model');
  });

  it('every vendor provider reports a default model', () => {
    for (const provider of [
      new AnthropicProvider({ apiKey: 'k' }),
      new OpenAIProvider({ apiKey: 'k' }),
      new GeminiProvider({ apiKey: 'k' }),
      new OllamaProvider(),
    ]) {
      expect(typeof provider.model).toBe('string');
      expect(provider.model).not.toBe('');
    }
  });

  it('RedactingProvider passes on the inner model, so a cache around it can key on it', () => {
    const redacting = new RedactingProvider(stubProvider({}, { model: 'inner-model' }), (t) => t);
    expect(redacting.model).toBe('inner-model');
    expect(new CachedProvider(redacting).model).toBe('inner-model');
  });
});

describe('MemoryCacheStore', () => {
  const entry: CacheEntry = { request: '{}', completion };

  it('returns undefined for missing keys', () => {
    const store = new MemoryCacheStore();
    expect(store.get('missing')).toBeUndefined();
  });

  it('stores and retrieves entries', () => {
    const store = new MemoryCacheStore();
    store.set('k', entry);
    expect(store.get('k')).toEqual(entry);
    expect(store.size).toBe(1);
  });

  it('clears all entries', () => {
    const store = new MemoryCacheStore();
    store.set('a', entry);
    store.set('b', entry);
    store.clear();
    expect(store.size).toBe(0);
  });
});
