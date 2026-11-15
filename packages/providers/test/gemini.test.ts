import { describe, it, expect, vi } from 'vitest';
import { GeminiProvider, ProviderError } from '../src/index.js';
import { ApiError } from '@google/genai';

function mockGenerateContent(result: unknown) {
  return vi.fn().mockResolvedValue(result);
}

function successResponse(overrides?: Partial<{ text: string; model: string }>) {
  return {
    text: overrides?.text ?? 'Hello from Gemini',
    usageMetadata: {
      promptTokenCount: 20,
      candidatesTokenCount: 6,
    },
    modelVersion: overrides?.model ?? 'gemini-2.5-flash',
  };
}

function makeProvider(
  generateContent: ReturnType<typeof mockGenerateContent>,
  config?: { model?: string },
) {
  const provider = new GeminiProvider({ apiKey: 'test-key', ...config });
  (
    provider as unknown as { client: { models: { generateContent: unknown } } }
  ).client.models.generateContent = generateContent;
  return provider;
}

describe('GeminiProvider', () => {
  describe('complete', () => {
    it('returns content, usage, and model from a successful response', async () => {
      const gen = mockGenerateContent(successResponse());
      const provider = makeProvider(gen);

      const result = await provider.complete([{ role: 'user', content: 'Hi' }]);

      expect(result.content).toBe('Hello from Gemini');
      expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 6 });
      expect(result.model).toBe('gemini-2.5-flash');
    });

    it('splits system messages into systemInstruction', async () => {
      const gen = mockGenerateContent(successResponse());
      const provider = makeProvider(gen);

      await provider.complete([
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ]);

      expect(gen).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            systemInstruction: 'You are helpful.',
          }),
        }),
      );
    });

    it('concatenates multiple system messages', async () => {
      const gen = mockGenerateContent(successResponse());
      const provider = makeProvider(gen);

      await provider.complete([
        { role: 'system', content: 'Be concise.' },
        { role: 'system', content: 'Use formal tone.' },
        { role: 'user', content: 'Hi' },
      ]);

      expect(gen).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            systemInstruction: 'Be concise.\n\nUse formal tone.',
          }),
        }),
      );
    });

    it('omits systemInstruction when no system messages are present', async () => {
      const gen = mockGenerateContent(successResponse());
      const provider = makeProvider(gen);

      await provider.complete([{ role: 'user', content: 'Hi' }]);

      const callArgs = gen.mock.calls[0][0];
      expect(callArgs.config.systemInstruction).toBeUndefined();
    });

    it('maps assistant role to model role', async () => {
      const gen = mockGenerateContent(successResponse());
      const provider = makeProvider(gen);

      await provider.complete([
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'How are you?' },
      ]);

      const contents = gen.mock.calls[0][0].contents;
      expect(contents).toEqual([
        { role: 'user', parts: [{ text: 'Hi' }] },
        { role: 'model', parts: [{ text: 'Hello' }] },
        { role: 'user', parts: [{ text: 'How are you?' }] },
      ]);
    });

    it('passes maxTokens and stop sequences', async () => {
      const gen = mockGenerateContent(successResponse());
      const provider = makeProvider(gen);

      await provider.complete([{ role: 'user', content: 'Hi' }], {
        maxTokens: 4096,
        stop: ['```'],
      });

      expect(gen).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            maxOutputTokens: 4096,
            stopSequences: ['```'],
          }),
        }),
      );
    });

    it('uses the configured model', async () => {
      const gen = mockGenerateContent(successResponse());
      const provider = makeProvider(gen, { model: 'gemini-2.5-pro' });

      await provider.complete([{ role: 'user', content: 'Hi' }]);

      expect(gen).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemini-2.5-pro' }));
    });

    it('defaults to gemini-2.5-flash when no model is configured', async () => {
      const gen = mockGenerateContent(successResponse());
      const provider = makeProvider(gen);

      await provider.complete([{ role: 'user', content: 'Hi' }]);

      expect(gen).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemini-2.5-flash' }));
    });

    it('returns empty string when text is undefined', async () => {
      const gen = mockGenerateContent({
        text: undefined,
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 },
      });
      const provider = makeProvider(gen);

      const result = await provider.complete([{ role: 'user', content: 'Hi' }]);
      expect(result.content).toBe('');
    });

    it('returns zero usage when usageMetadata is missing', async () => {
      const gen = mockGenerateContent({ text: 'ok' });
      const provider = makeProvider(gen);

      const result = await provider.complete([{ role: 'user', content: 'Hi' }]);
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });
  });

  describe('error mapping', () => {
    function apiError(status: number, message: string): ApiError {
      return new ApiError({ status, message });
    }

    it('maps 401 to auth', async () => {
      const gen = vi.fn().mockRejectedValue(apiError(401, 'invalid key'));
      const provider = makeProvider(gen);

      await expect(provider.complete([{ role: 'user', content: 'Hi' }])).rejects.toMatchObject({
        code: 'auth',
        provider: 'gemini',
      });
    });

    it('maps 403 to auth', async () => {
      const gen = vi.fn().mockRejectedValue(apiError(403, 'forbidden'));
      const provider = makeProvider(gen);

      await expect(provider.complete([{ role: 'user', content: 'Hi' }])).rejects.toMatchObject({
        code: 'auth',
        provider: 'gemini',
      });
    });

    it('maps 429 to rate_limit (retryable)', async () => {
      const gen = vi.fn().mockRejectedValue(apiError(429, 'rate limited'));
      const provider = makeProvider(gen);

      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        expect((e as ProviderError).code).toBe('rate_limit');
        expect((e as ProviderError).retryable).toBe(true);
      }
    });

    it('maps 404 to model_not_found', async () => {
      const gen = vi.fn().mockRejectedValue(apiError(404, 'model not found'));
      const provider = makeProvider(gen);

      await expect(provider.complete([{ role: 'user', content: 'Hi' }])).rejects.toMatchObject({
        code: 'model_not_found',
      });
    });

    it('maps 5xx to server_error (retryable)', async () => {
      const gen = vi.fn().mockRejectedValue(apiError(500, 'internal error'));
      const provider = makeProvider(gen);

      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        expect((e as ProviderError).code).toBe('server_error');
        expect((e as ProviderError).retryable).toBe(true);
      }
    });

    it('maps context length 400 error correctly', async () => {
      const gen = vi.fn().mockRejectedValue(apiError(400, 'exceeds the maximum context window'));
      const provider = makeProvider(gen);

      await expect(provider.complete([{ role: 'user', content: 'Hi' }])).rejects.toMatchObject({
        code: 'context_length',
      });
    });

    it('maps connection errors to network', async () => {
      const err = new Error('fetch failed');
      err.name = 'ConnectionError';
      const gen = vi.fn().mockRejectedValue(err);
      const provider = makeProvider(gen);

      await expect(provider.complete([{ role: 'user', content: 'Hi' }])).rejects.toMatchObject({
        code: 'network',
        provider: 'gemini',
      });
    });
  });

  it('exposes name as "gemini"', () => {
    const provider = new GeminiProvider({ apiKey: 'test-key' });
    expect(provider.name).toBe('gemini');
  });
});
