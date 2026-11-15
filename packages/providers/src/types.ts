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
 */
export interface CompleteOptions {
  maxTokens?: number;
  stop?: string[];
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
 * The structured result of a completion call. `content` is the raw
 * model output (the healer parses it into a patch); `usage` carries
 * token counts for cost tracking; `model` names the exact model
 * string the provider resolved to (useful when a provider alias
 * like "claude-sonnet" resolves to a dated snapshot).
 */
export interface Completion {
  content: string;
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
    this.retryable = opts.code === 'rate_limit' || opts.code === 'server_error';
  }
}
