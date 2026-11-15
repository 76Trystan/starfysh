import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicProvider, ProviderError } from '../src/index.js';

function mockCreate(result: unknown) {
  return vi.fn().mockResolvedValue(result);
}

function successResponse(overrides?: Partial<{ content: unknown[]; model: string }>) {
  return {
    content: overrides?.content ?? [{ type: 'text' as const, text: 'Hello from Claude' }],
    model: overrides?.model ?? 'claude-sonnet-5-5',
    usage: { input_tokens: 42, output_tokens: 10 },
    stop_reason: 'end_turn',
  };
}

function makeProvider(create: ReturnType<typeof mockCreate>, config?: { model?: string }) {
  const provider = new AnthropicProvider({ apiKey: 'test-key', ...config });
  // Replace the internal client's messages.create with our mock
  (provider as unknown as { client: { messages: { create: unknown } } }).client.messages.create =
    create;
  return provider;
}

describe('AnthropicProvider', () => {
  describe('complete', () => {
    it('returns content, usage, and model from a successful response', async () => {
      const create = mockCreate(successResponse());
      const provider = makeProvider(create);

      const result = await provider.complete([{ role: 'user', content: 'Hi' }]);

      expect(result.content).toBe('Hello from Claude');
      expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 10 });
      expect(result.model).toBe('claude-sonnet-5-5');
    });

    it('splits system messages from conversation messages', async () => {
      const create = mockCreate(successResponse());
      const provider = makeProvider(create);

      await provider.complete([
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ]);

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          system: 'You are helpful.',
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      );
    });

    it('concatenates multiple leading system messages', async () => {
      const create = mockCreate(successResponse());
      const provider = makeProvider(create);

      await provider.complete([
        { role: 'system', content: 'Rule one.' },
        { role: 'system', content: 'Rule two.' },
        { role: 'user', content: 'Hi' },
      ]);

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          system: 'Rule one.\n\nRule two.',
        }),
      );
    });

    it('omits system when no system messages are present', async () => {
      const create = mockCreate(successResponse());
      const provider = makeProvider(create);

      await provider.complete([{ role: 'user', content: 'Hi' }]);

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          system: undefined,
        }),
      );
    });

    it('passes maxTokens and stop sequences', async () => {
      const create = mockCreate(successResponse());
      const provider = makeProvider(create);

      await provider.complete([{ role: 'user', content: 'Hi' }], {
        maxTokens: 4096,
        stop: ['```'],
      });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          max_tokens: 4096,
          stop_sequences: ['```'],
        }),
      );
    });

    it('uses the configured model', async () => {
      const create = mockCreate(successResponse({ model: 'claude-opus-5-5' }));
      const provider = makeProvider(create, { model: 'claude-opus-5-5' });

      await provider.complete([{ role: 'user', content: 'Hi' }]);

      expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-opus-5-5' }));
    });

    it('defaults to claude-sonnet-5-5 when no model is configured', async () => {
      const create = mockCreate(successResponse());
      const provider = makeProvider(create);

      await provider.complete([{ role: 'user', content: 'Hi' }]);

      expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-sonnet-5-5' }));
    });

    it('concatenates multiple text blocks in the response', async () => {
      const create = mockCreate(
        successResponse({
          content: [
            { type: 'text', text: 'Part 1. ' },
            { type: 'thinking', thinking: '...' },
            { type: 'text', text: 'Part 2.' },
          ],
        }),
      );
      const provider = makeProvider(create);

      const result = await provider.complete([{ role: 'user', content: 'Hi' }]);
      expect(result.content).toBe('Part 1. Part 2.');
    });

    it('returns empty content when response has no text blocks', async () => {
      const create = mockCreate(
        successResponse({
          content: [{ type: 'thinking', thinking: 'internal reasoning' }],
        }),
      );
      const provider = makeProvider(create);

      const result = await provider.complete([{ role: 'user', content: 'Hi' }]);
      expect(result.content).toBe('');
    });
  });

  describe('error mapping', () => {
    // Helper to create Anthropic-shaped errors with the right prototype chain
    function anthropicError(
      ErrorClass: new (...args: unknown[]) => Error,
      message: string,
      status?: number,
    ) {
      const err = Object.create(ErrorClass.prototype);
      err.message = message;
      err.name = ErrorClass.name;
      if (status !== undefined) err.status = status;
      return err;
    }

    let Anthropic: typeof import('@anthropic-ai/sdk').default;
    beforeEach(async () => {
      Anthropic = (await import('@anthropic-ai/sdk')).default;
    });

    it('maps AuthenticationError to auth', async () => {
      const create = vi
        .fn()
        .mockRejectedValue(anthropicError(Anthropic.AuthenticationError, 'invalid key', 401));
      const provider = makeProvider(create);

      await expect(provider.complete([{ role: 'user', content: 'Hi' }])).rejects.toThrow(
        ProviderError,
      );

      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        expect((e as ProviderError).code).toBe('auth');
        expect((e as ProviderError).provider).toBe('anthropic');
        expect((e as ProviderError).retryable).toBe(false);
      }
    });

    it('maps RateLimitError to rate_limit (retryable)', async () => {
      const create = vi
        .fn()
        .mockRejectedValue(anthropicError(Anthropic.RateLimitError, 'slow down', 429));
      const provider = makeProvider(create);

      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        expect((e as ProviderError).code).toBe('rate_limit');
        expect((e as ProviderError).retryable).toBe(true);
      }
    });

    it('maps NotFoundError to model_not_found', async () => {
      const create = vi
        .fn()
        .mockRejectedValue(anthropicError(Anthropic.NotFoundError, 'no such model', 404));
      const provider = makeProvider(create);

      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        expect((e as ProviderError).code).toBe('model_not_found');
      }
    });

    it('maps 5xx APIError to server_error (retryable)', async () => {
      const create = vi
        .fn()
        .mockRejectedValue(anthropicError(Anthropic.APIError, 'internal error', 500));
      const provider = makeProvider(create);

      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        expect((e as ProviderError).code).toBe('server_error');
        expect((e as ProviderError).retryable).toBe(true);
      }
    });

    it('maps APIConnectionError to network', async () => {
      const create = vi
        .fn()
        .mockRejectedValue(anthropicError(Anthropic.APIConnectionError, 'ECONNREFUSED'));
      const provider = makeProvider(create);

      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        expect((e as ProviderError).code).toBe('network');
        expect((e as ProviderError).retryable).toBe(false);
      }
    });

    it('maps BadRequestError with context keywords to context_length', async () => {
      const create = vi
        .fn()
        .mockRejectedValue(
          anthropicError(Anthropic.BadRequestError, 'prompt is too long: too many tokens', 400),
        );
      const provider = makeProvider(create);

      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        expect((e as ProviderError).code).toBe('context_length');
      }
    });

    it('maps unknown errors to unknown', async () => {
      const create = vi.fn().mockRejectedValue(new Error('something unexpected'));
      const provider = makeProvider(create);

      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        expect((e as ProviderError).code).toBe('unknown');
        expect((e as ProviderError).provider).toBe('anthropic');
      }
    });
  });

  it('exposes name as "anthropic"', () => {
    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    expect(provider.name).toBe('anthropic');
  });
});
