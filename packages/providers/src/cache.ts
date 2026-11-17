// A cache of completions, keyed on everything that changes the answer.
//
// The key is SHA-256 over the provider name, the model, the messages and
// the options that change what the model is asked (`maxTokens`, `stop`).
// Leaving the provider or the model out would let a completion from one
// model be served for a request to another, so a `CachedProvider` that
// cannot learn its model refuses to be built.
//
// Each entry also stores the request it answers, and a hit is only served
// when that request matches exactly. A SHA-256 collision is not a
// practical worry; a store on disk that was edited, truncated or shared
// between projects is, and the comparison catches all of those.

import { createHash } from 'node:crypto';
import type { Provider, Message, CompleteOptions, Completion } from './types.js';

/** What a store holds for one key. */
export interface CacheEntry {
  /** The canonical request (see `canonicalRequest`). Compared on every hit. */
  request: string;
  completion: Completion;
}

export interface CacheStore {
  get(key: string): CacheEntry | undefined;
  set(key: string, entry: CacheEntry): void;
}

export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, CacheEntry>();

  get(key: string): CacheEntry | undefined {
    return this.entries.get(key);
  }

  set(key: string, entry: CacheEntry): void {
    this.entries.set(key, entry);
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
  /**
   * The model to key on, when the inner provider does not report one
   * (a test double, or a provider that picks its model per call). Ignored
   * when the inner provider has a `model`.
   */
  model?: string;
}

/**
 * The request as one string, with a fixed field order so the same request
 * always gives the same string. Only what changes the answer is included:
 * `timeoutMs` and `signal` bound how long the caller waits, so the same
 * request with a different deadline finds the same entry.
 */
export function canonicalRequest(
  provider: string,
  model: string,
  messages: Message[],
  options?: CompleteOptions,
): string {
  return JSON.stringify({
    v: 1,
    provider,
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    maxTokens: options?.maxTokens ?? null,
    stop: options?.stop ?? null,
  });
}

/** The cache key for a canonical request: 64 hex characters of SHA-256. */
export function cacheKey(request: string): string {
  return createHash('sha256').update(request, 'utf8').digest('hex');
}

export class CachedProvider implements Provider {
  readonly name: string;
  readonly model: string;
  private readonly inner: Provider;
  private readonly store: CacheStore;
  private _hits = 0;
  private _misses = 0;
  private _mismatches = 0;

  constructor(inner: Provider, config: CachedProviderConfig = {}) {
    const model = inner.model ?? config.model;
    if (model === undefined || model === '') {
      throw new TypeError(
        `CachedProvider needs the model to key on, and provider '${inner.name}' does not report one. Pass { model } in the config.`,
      );
    }
    this.name = inner.name;
    this.model = model;
    this.inner = inner;
    this.store = config.store ?? new MemoryCacheStore();
  }

  async complete(messages: Message[], options?: CompleteOptions): Promise<Completion> {
    const request = canonicalRequest(this.name, this.model, messages, options);
    const key = cacheKey(request);
    const cached = this.store.get(key);
    if (cached !== undefined) {
      if (cached.request === request) {
        this._hits++;
        return cached.completion;
      }
      // Same key, different request. Treat it as a miss and overwrite.
      this._mismatches++;
    }

    const completion = await this.inner.complete(messages, options);
    this.store.set(key, { request, completion });
    this._misses++;
    return completion;
  }

  get hits(): number {
    return this._hits;
  }

  get misses(): number {
    return this._misses;
  }

  /** Lookups that found an entry for a different request under the same key. Counted in `misses` too. */
  get mismatches(): number {
    return this._mismatches;
  }
}
