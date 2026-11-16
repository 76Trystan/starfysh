import type { Provider, Message, CompleteOptions, Completion } from './types.js';

/**
 * Removes secrets from a string. In Starfysh this is a run's
 * `ctx.redact`, which replaces every registered vault secret (and its
 * encoded forms) with a `[REDACTED:<name>]` marker. This package does not
 * depend on the runtime, so the function is all it needs to know about.
 */
export type RedactFn = (text: string) => string;

/**
 * Wraps a provider so that nothing leaves the process without passing
 * through a redaction function first. Every message's `content` and every
 * `stop` string is redacted before the inner provider is called.
 *
 * This is the last line of defence, not the first. Whoever builds the
 * prompt should already be redacting what goes into it. The wrapper is
 * here so that a prompt builder that forgets, or a new code path that
 * never knew it had to, cannot send a secret to a model vendor.
 *
 * Put it outermost, around any `CachedProvider`:
 *
 *     new RedactingProvider(new CachedProvider(new AnthropicProvider()), ctx.redact)
 *
 * In that order the cache only ever sees redacted text, so its keys and
 * anything a custom store writes to disk are free of secrets. The other
 * order still keeps secrets away from the vendor, but the cache would be
 * keyed on the raw request.
 *
 * It fails closed. If the redaction function throws, or returns something
 * that is not a string, the call rejects and no request is made.
 *
 * The response is not redacted. The model was never shown the secret, so
 * it has nothing to repeat.
 */
export class RedactingProvider implements Provider {
  readonly name: string;
  private readonly inner: Provider;
  private readonly redact: RedactFn;

  constructor(inner: Provider, redact: RedactFn) {
    this.name = inner.name;
    this.inner = inner;
    this.redact = redact;
  }

  async complete(messages: Message[], options?: CompleteOptions): Promise<Completion> {
    const safeMessages = messages.map((message) => ({
      role: message.role,
      content: this.apply(message.content),
    }));

    // `options` is passed through by reference when there is nothing to
    // redact in it, so an `AbortSignal` on it keeps its identity.
    const safeOptions =
      options?.stop === undefined
        ? options
        : { ...options, stop: options.stop.map((s) => this.apply(s)) };

    return this.inner.complete(safeMessages, safeOptions);
  }

  private apply(text: string): string {
    const result: unknown = this.redact(text);
    if (typeof result !== 'string') {
      throw new TypeError(
        `Redaction function returned ${result === null ? 'null' : typeof result}, not a string. Refusing to send the request.`,
      );
    }
    return result;
  }
}
