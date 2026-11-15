import { describe, it, expect } from 'vitest';
import { ProviderError } from '../src/index.js';
import type { Provider, Message, Completion } from '../src/index.js';

describe('ProviderError', () => {
  it('carries code, provider name, and message', () => {
    const err = new ProviderError('key expired', {
      code: 'auth',
      provider: 'anthropic',
    });
    expect(err.message).toBe('key expired');
    expect(err.code).toBe('auth');
    expect(err.provider).toBe('anthropic');
    expect(err.name).toBe('ProviderError');
  });

  it('marks rate_limit as retryable', () => {
    const err = new ProviderError('slow down', {
      code: 'rate_limit',
      provider: 'openai',
    });
    expect(err.retryable).toBe(true);
  });

  it('marks server_error as retryable', () => {
    const err = new ProviderError('500', {
      code: 'server_error',
      provider: 'ollama',
    });
    expect(err.retryable).toBe(true);
  });

  it('marks auth as not retryable', () => {
    const err = new ProviderError('bad key', {
      code: 'auth',
      provider: 'anthropic',
    });
    expect(err.retryable).toBe(false);
  });

  it('marks context_length as not retryable', () => {
    const err = new ProviderError('too long', {
      code: 'context_length',
      provider: 'openai',
    });
    expect(err.retryable).toBe(false);
  });

  it('preserves the cause when provided', () => {
    const cause = new Error('socket hangup');
    const err = new ProviderError('network failure', {
      code: 'network',
      provider: 'ollama',
      cause,
    });
    expect(err.cause).toBe(cause);
  });

  it('is an instance of Error', () => {
    const err = new ProviderError('oops', {
      code: 'unknown',
      provider: 'test',
    });
    expect(err).toBeInstanceOf(Error);
  });
});

describe('Provider interface', () => {
  it('can be implemented with a minimal stub', async () => {
    const stub: Provider = {
      name: 'stub',
      complete: async (messages: Message[]): Promise<Completion> => ({
        content: `echo: ${messages.length} messages`,
        usage: { inputTokens: 10, outputTokens: 5 },
        model: 'stub-1',
      }),
    };

    const result = await stub.complete([{ role: 'user', content: 'hello' }]);
    expect(result.content).toBe('echo: 1 messages');
    expect(result.usage.inputTokens).toBe(10);
    expect(result.model).toBe('stub-1');
  });

  it('accepts optional CompleteOptions', async () => {
    const stub: Provider = {
      name: 'stub',
      complete: async () => ({
        content: 'ok',
        usage: { inputTokens: 0, outputTokens: 0 },
        model: 'stub-1',
      }),
    };

    const result = await stub.complete([{ role: 'user', content: 'hi' }], {
      temperature: 0,
      maxTokens: 100,
      stop: ['\n'],
    });
    expect(result.content).toBe('ok');
  });
});
