/**
 * A single message in a completion request. The healer builds a
 * conversation (system context, then user prompt with the failed step
 * and accessibility snapshot) and the provider turns it into whatever
 * wire format the model API expects.
 */
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Options passed to {@link Provider.complete}. maxTokens has a sane
 * default per provider; callers override it when the healer expects
 * a long patch. Temperature is intentionally absent: the Anthropic
 * API removed sampling parameters on 2026-10-21, and the healer
 * controls output depth via the `effort` config on the provider,
 * not per-call temperature.
 *
 * `timeoutMs` and `signal` bound how long a call may run. There is no
 * default timeout here: without one, a call waits as long as the vendor
 * SDK allows, which is ten minutes for the Anthropic and OpenAI clients.
 * A caller that must not hang (the healer) sets its own. Neither option
 * changes what the model is asked, so neither is part of the cache key.
 */
export interface CompleteOptions {
  maxTokens?: number;
  stop?: string[];
  /**
   * Give up after this many milliseconds. The call rejects with a
   * `ProviderError` whose code is `timeout`. Must be positive and finite.
   */
  timeoutMs?: number;
  /**
   * Cancel the call when this signal aborts. The call rejects with a
   * `ProviderError` whose code is `aborted`, and the signal's reason is
   * kept as the error's `cause`.
   */
  signal?: AbortSignal;
}

/**
 * Token usage reported by the model. The healer logs this for
 * cost tracking; the content-hash cache uses it to measure savings.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Why the model stopped writing, normalised across vendors.
 *
 * - `end`: the model finished its answer on its own.
 * - `max_tokens`: the output was cut off, either by `maxTokens` or by the
 *   model's context window. `content` is incomplete.
 * - `stop_sequence`: one of the caller's `stop` strings was produced. Only
 *   Anthropic reports this separately; OpenAI-compatible APIs and Gemini
 *   report a stop sequence the same way as a natural finish, so those
 *   providers return `end` for both.
 * - `refusal`: the model declined or a safety filter cut the output.
 *   `content` may be empty or partial.
 * - `other`: anything else, including a reason the vendor did not report.
 *
 * Only `end` and `stop_sequence` mean the content is what the model meant
 * to write. A caller that parses the content (the healer parses it into a
 * patch) must check this first, because truncated output can still look
 * well formed.
 */
export type StopReason = 'end' | 'max_tokens' | 'stop_sequence' | 'refusal' | 'other';

/**
 * The structured result of a completion call. `content` is the raw
 * model output (the healer parses it into a patch); `stopReason` says
 * whether that output is complete; `usage` carries token counts for
 * cost tracking; `model` names the exact model string the provider
 * resolved to (useful when a provider alias like "claude-sonnet"
 * resolves to a dated snapshot).
 */
export interface Completion {
  content: string;
  stopReason: StopReason;
  usage: TokenUsage;
  model: string;
}

/**
 * The interface every model backend must satisfy. The healer and
 * future authoring agent program against this, never against a
 * vendor SDK directly.
 *
 * Providers are stateless: each `complete()` call is independent.
 * Conversation history is the caller's responsibility (the healer
 * builds it from the failed step, triage result, and snapshot).
 */
export interface Provider {
  readonly name: string;
  /**
   * The model this provider asks for, as configured. Wrappers pass on
   * their inner provider's. `CachedProvider` needs it for its cache key
   * and `MeteredProvider` for pricing. Optional so that a test double can
   * leave it out; every vendor provider sets it.
   */
  readonly model?: string | undefined;
  complete(messages: Message[], options?: CompleteOptions): Promise<Completion>;
}

/**
 * Configuration common to all provider constructors. Individual
 * providers extend this with vendor-specific fields (baseUrl for
 * Ollama, region for Bedrock, etc.).
 */
export interface ProviderConfig {
  apiKey?: string;
  model?: string;
}

/**
 * Error thrown when a provider call fails in a way the caller can
 * reason about: rate limiting, authentication, model not found,
 * context length exceeded. The `code` field lets the healer decide
 * whether to retry, fall back to another provider, or give up.
 */
export type ProviderErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'context_length'
  | 'model_not_found'
  | 'server_error'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'budget_exceeded'
  | 'unknown';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    opts: { code: ProviderErrorCode; provider: string; cause?: unknown },
  ) {
    super(message, { cause: opts.cause });
    this.name = 'ProviderError';
    this.code = opts.code;
    this.provider = opts.provider;
    // A timeout is worth one more try: the request may have been slow, not
    // wrong. An abort is the caller's own decision, so it is never retried.
    this.retryable =
      opts.code === 'rate_limit' || opts.code === 'server_error' || opts.code === 'timeout';
  }
}
