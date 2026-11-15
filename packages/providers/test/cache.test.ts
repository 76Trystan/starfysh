import { describe, it, expect, vi } from 'vitest';
import { CachedProvider, MemoryCacheStore } from '../src/index.js';
import type { Provider, Completion, Message } from '../src/index.js';

function stubProvider(result?: Partial<Completion>): Provider {
  return {
    name: 'stub',
    complete: vi.fn().mockResolvedValue({
      content: result?.content ?? 'response',
      usage: result?.usage ?? { inputTokens: 10, outputTokens: 5 },
      model: result?.model ?? 'stub-model',
    }),
  };
}

const msgs: Message[] = [{ role: 'user', content: 'Hello' }];

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

  it('treats different options as different cache keys', async () => {
    const inner = stubProvider();
    const cached = new CachedProvider(inner);

    await cached.complete(msgs, { maxTokens: 100 });
    await cached.complete(msgs, { maxTokens: 200 });

    expect(inner.complete).toHaveBeenCalledTimes(2);
  });

  it('treats identical options as the same cache key', async () => {
    const inner = stubProvider();
    const cached = new CachedProvider(inner);

    await cached.complete(msgs, { maxTokens: 100, stop: ['x'] });
    await cached.complete(msgs, { maxTokens: 100, stop: ['x'] });

    expect(inner.complete).toHaveBeenCalledTimes(1);
    expect(cached.hits).toBe(1);
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

  it('propagates errors from the inner provider', async () => {
    const inner: Provider = {
      name: 'failing',
      complete: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const cached = new CachedProvider(inner);

    await expect(cached.complete(msgs)).rejects.toThrow('boom');
    expect(cached.misses).toBe(0);
    expect(cached.hits).toBe(0);
  });
});

describe('MemoryCacheStore', () => {
  it('returns undefined for missing keys', () => {
    const store = new MemoryCacheStore();
    expect(store.get('missing')).toBeUndefined();
  });

  it('stores and retrieves entries', () => {
    const store = new MemoryCacheStore();
    const entry: Completion = {
      content: 'cached',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'm',
    };
    store.set('k', entry);
    expect(store.get('k')).toEqual(entry);
    expect(store.size).toBe(1);
  });

  it('clears all entries', () => {
    const store = new MemoryCacheStore();
    const entry: Completion = {
      content: 'cached',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'm',
    };
    store.set('a', entry);
    store.set('b', entry);
    store.clear();
    expect(store.size).toBe(0);
  });
});
