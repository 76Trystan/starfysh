import { describe, it, expect, vi } from 'vitest';
import { OllamaProvider, ProviderError } from '../src/index.js';

function mockCreate(result: unknown) {
  return vi.fn().mockResolvedValue(result);
}

function successResponse() {
  return {
    choices: [
      {
        message: { role: 'assistant', content: 'Hello from Ollama' },
        finish_reason: 'stop',
        index: 0,
      },
    ],
    model: 'llama3.2',
    usage: { prompt_tokens: 15, completion_tokens: 4, total_tokens: 19 },
  };
}

function makeProvider(create: ReturnType<typeof mockCreate>, config?: { model?: string }) {
  const provider = new OllamaProvider(config);
  (
    provider as unknown as { client: { chat: { completions: { create: unknown } } } }
  ).client.chat.completions.create = create;
  return provider;
}

describe('OllamaProvider', () => {
  it('exposes name as "ollama"', () => {
    const provider = new OllamaProvider();
    expect(provider.name).toBe('ollama');
  });

  it('returns content, usage, and model from a successful response', async () => {
    const create = mockCreate(successResponse());
    const provider = makeProvider(create);

    const result = await provider.complete([{ role: 'user', content: 'Hi' }]);

    expect(result.content).toBe('Hello from Ollama');
    expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 4 });
    expect(result.model).toBe('llama3.2');
  });

  it('defaults to llama3.2 model', async () => {
    const create = mockCreate(successResponse());
    const provider = makeProvider(create);

    await provider.complete([{ role: 'user', content: 'Hi' }]);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'llama3.2' }));
  });

  it('uses configured model', async () => {
    const create = mockCreate(successResponse());
    const provider = makeProvider(create, { model: 'mistral' });

    await provider.complete([{ role: 'user', content: 'Hi' }]);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'mistral' }));
  });

  it('tags errors with provider "ollama"', async () => {
    const err = new Error('ECONNREFUSED');
    const create = vi.fn().mockRejectedValue(err);
    const provider = makeProvider(create);

    try {
      await provider.complete([{ role: 'user', content: 'Hi' }]);
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).provider).toBe('ollama');
    }
  });

  it('constructs with default base URL pointing to localhost:11434', () => {
    const provider = new OllamaProvider();
    const client = (provider as unknown as { client: { baseURL: string } }).client;
    expect(client.baseURL).toBe('http://localhost:11434/v1');
  });

  it('accepts custom base URL', () => {
    const provider = new OllamaProvider({ baseUrl: 'http://gpu-server:11434/v1' });
    const client = (provider as unknown as { client: { baseURL: string } }).client;
    expect(client.baseURL).toBe('http://gpu-server:11434/v1');
  });
});
