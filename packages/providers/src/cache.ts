import type { Provider, Message, CompleteOptions, Completion } from './types.js';

export interface CacheStore {
  get(key: string): Completion | undefined;
  set(key: string, value: Completion): void;
}

export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, Completion>();

  get(key: string): Completion | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: Completion): void {
    this.entries.set(key, value);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface CachedProviderConfig {
  store?: CacheStore;
}

export class CachedProvider implements Provider {
  readonly name: string;
  private readonly inner: Provider;
  private readonly store: CacheStore;
  private _hits = 0;
  private _misses = 0;

  constructor(inner: Provider, config: CachedProviderConfig = {}) {
    this.name = inner.name;
    this.inner = inner;
    this.store = config.store ?? new MemoryCacheStore();
  }

  async complete(messages: Message[], options?: CompleteOptions): Promise<Completion> {
    const key = hashRequest(messages, options);
    const cached = this.store.get(key);
    if (cached !== undefined) {
      this._hits++;
      return cached;
    }

    const result = await this.inner.complete(messages, options);
    this.store.set(key, result);
    this._misses++;
    return result;
  }

  get hits(): number {
    return this._hits;
  }

  get misses(): number {
    return this._misses;
  }
}

function hashRequest(messages: Message[], options?: CompleteOptions): string {
  const payload = JSON.stringify({ messages, options: options ?? {} });
  return fnv1a(payload);
}

function fnv1a(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(36);
}
