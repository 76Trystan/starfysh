import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIProvider, ProviderError } from '../src/index.js';

function mockCreate(result: unknown) {
  return vi.fn().mockResolvedValue(result);
}

function successResponse(overrides?: Partial<{ content: string | null; model: string }>) {
  return {
    choices: [
      {
        message: { role: 'assistant', content: overrides?.content ?? 'Hello from GPT' },
        finish_reason: 'stop',
        index: 0,
      },
    ],
    model: overrides?.model ?? 'gpt-4o-2024-08-06',
    usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
  };
}

function makeProvider(create: ReturnType<typeof mockCreate>, config?: { model?: string }) {
  const provider = new OpenAIProvider({ apiKey: 'test-key', ...config });
  (
    provider as unknown as { client: { chat: { completions: { create: unknown } } } }
  ).client.chat.completions.create = create;
  return provider;
}

describe('OpenAIProvider', () => {
  describe('complete', () => {
    it('returns content, usage, and model from a successful response', async () => {
      const create = mockCreate(successResponse());
      const provider = makeProvider(create);

      const result = await provider.complete([{ role: 'user', content: 'Hi' }]);

      expect(result.content).toBe('Hello from GPT');
      expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 8 });
      expect(result.model).toBe('gpt-4o-2024-08-06');
    });

    it('passes system messages directly in the messages array', async () => {
      const create = mockCreate(successResponse());
      const provider = makeProvider(create);

      await provider.complete([
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ]);

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Hi' },
          ],
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
          stop: ['```'],
        }),
      );
    });

    it('uses the configured model', async () => {
      const create = mockCreate(successResponse({ model: 'gpt-4o-mini' }));
      const provider = makeProvider(create, { model: 'gpt-4o-mini' });

      await provider.complete([{ role: 'user', content: 'Hi' }]);

      expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4o-mini' }));
    });

    it('defaults to gpt-4o when no model is configured', async () => {
      const create = mockCreate(successResponse());
      const provider = makeProvider(create);

      await provider.complete([{ role: 'user', content: 'Hi' }]);

      expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4o' }));
    });

    it('returns empty string when content is null', async () => {
      const create = mockCreate({
        choices: [
          { message: { role: 'assistant', content: null }, finish_reason: 'stop', index: 0 },
        ],
        model: 'gpt-4o',
        usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
      });
      const provider = makeProvider(create);

      const result = await provider.complete([{ role: 'user', content: 'Hi' }]);
      expect(result.content).toBe('');
    });

    it('returns zero usage when usage is missing', async () => {
      const create = mockCreate({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop', index: 0 }],
        model: 'gpt-4o',
      });
      const provider = makeProvider(create);

      const result = await provider.complete([{ role: 'user', content: 'Hi' }]);
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });
  });

  describe('error mapping', () => {
    function openaiError(
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

    let OpenAI: typeof import('openai').default;
    beforeEach(async () => {
      OpenAI = (await import('openai')).default;
    });

    it('maps AuthenticationError to auth', async () => {
      const create = vi
        .fn()
        .mockRejectedValue(openaiError(OpenAI.AuthenticationError, 'invalid key', 401));
      const provider = makeProvider(create);

      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        expect((e as ProviderError).code).toBe('auth');
        expect((e as ProviderError).provider).toBe('openai');
      }
    });

    it('maps RateLimitError to rate_limit (retryable)', async () => {
      const create = vi
        .fn()
        .mockRejectedValue(openaiError(OpenAI.RateLimitError, 'rate limited', 429));
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
        .mockRejectedValue(openaiError(OpenAI.NotFoundError, 'model not found', 404));
      const provider = makeProvider(create);

      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        expect((e as ProviderError).code).toBe('model_not_found');
      }
    });

    it('maps APIConnectionError to network', async () => {
      const create = vi
        .fn()
        .mockRejectedValue(openaiError(OpenAI.APIConnectionError, 'ECONNREFUSED'));
      const provider = makeProvider(create);

      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        expect((e as ProviderError).code).toBe('network');
      }
    });

    it('maps 5xx APIError to server_error (retryable)', async () => {
      const create = vi.fn().mockRejectedValue(openaiError(OpenAI.APIError, 'internal error', 500));
      const provider = makeProvider(create);

      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        expect((e as ProviderError).code).toBe('server_error');
        expect((e as ProviderError).retryable).toBe(true);
      }
    });

    it('maps context length BadRequestError correctly', async () => {
      const create = vi
        .fn()
        .mockRejectedValue(
          openaiError(OpenAI.BadRequestError, 'maximum context length exceeded', 400),
        );
      const provider = makeProvider(create);

      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        expect((e as ProviderError).code).toBe('context_length');
      }
    });
  });

  it('exposes name as "openai"', () => {
    const provider = new OpenAIProvider({ apiKey: 'test-key' });
    expect(provider.name).toBe('openai');
  });
});
