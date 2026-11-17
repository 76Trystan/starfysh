import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicProvider,
  CachedProvider,
  GeminiProvider,
  OllamaProvider,
  OpenAIProvider,
  RedactingProvider,
} from '../src/index.js';
import type { CacheStore, Completion, Message, Provider } from '../src/index.js';

const SECRET = 'hunter2-secret';

/** Stands in for a run's `ctx.redact` with one registered secret. */
const redact = (text: string): string => text.split(SECRET).join('[REDACTED:portal_pass]');

const completion: Completion = {
  content: '{"op":"replace"}',
  stopReason: 'end',
  usage: { inputTokens: 10, outputTokens: 5 },
  model: 'stub-model',
};

function stubProvider(): Provider & { complete: ReturnType<typeof vi.fn> } {
  return { name: 'stub', model: 'stub-model', complete: vi.fn().mockResolvedValue(completion) };
}

const leakyMessages: Message[] = [
  { role: 'system', content: 'You repair one workflow step.' },
  { role: 'user', content: `fill failed for value "${SECRET}"` },
  { role: 'assistant', content: `I see ${SECRET} twice: ${SECRET}` },
];

describe('RedactingProvider', () => {
  it('redacts every message before the inner provider sees it', async () => {
    const inner = stubProvider();
    await new RedactingProvider(inner, redact).complete(leakyMessages);

    expect(inner.complete).toHaveBeenCalledWith(
      [
        { role: 'system', content: 'You repair one workflow step.' },
        { role: 'user', content: 'fill failed for value "[REDACTED:portal_pass]"' },
        {
          role: 'assistant',
          content: 'I see [REDACTED:portal_pass] twice: [REDACTED:portal_pass]',
        },
      ],
      undefined,
    );
  });

  it('does not change the caller’s messages', async () => {
    const messages: Message[] = [{ role: 'user', content: `value ${SECRET}` }];
    await new RedactingProvider(stubProvider(), redact).complete(messages);
    expect(messages).toEqual([{ role: 'user', content: `value ${SECRET}` }]);
  });

  it('redacts stop sequences and keeps the other options', async () => {
    const inner = stubProvider();
    const signal = new AbortController().signal;

    await new RedactingProvider(inner, redact).complete(leakyMessages, {
      maxTokens: 500,
      timeoutMs: 1_000,
      signal,
      stop: [SECRET, '</patch>'],
    });

    const options = inner.complete.mock.calls[0]![1];
    expect(options).toEqual({
      maxTokens: 500,
      timeoutMs: 1_000,
      signal,
      stop: ['[REDACTED:portal_pass]', '</patch>'],
    });
    expect(options.signal).toBe(signal);
  });

  it('passes options through by reference when there is no stop list', async () => {
    const inner = stubProvider();
    const options = { maxTokens: 500 };
    await new RedactingProvider(inner, redact).complete(leakyMessages, options);
    expect(inner.complete.mock.calls[0]![1]).toBe(options);
  });

  it('takes the name of the provider it wraps and returns its completion', async () => {
    const provider = new RedactingProvider(stubProvider(), redact);
    expect(provider.name).toBe('stub');
    expect(await provider.complete(leakyMessages)).toBe(completion);
  });

  it('makes no request when the redaction function throws', async () => {
    const inner = stubProvider();
    const broken = new RedactingProvider(inner, () => {
      throw new Error('scrubber exploded');
    });

    await expect(broken.complete(leakyMessages)).rejects.toThrow('scrubber exploded');
    expect(inner.complete).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 42])(
    'makes no request when the redaction function returns %s',
    async (bad) => {
      const inner = stubProvider();
      const broken = new RedactingProvider(inner, (() => bad) as unknown as (t: string) => string);

      await expect(broken.complete(leakyMessages)).rejects.toBeInstanceOf(TypeError);
      expect(inner.complete).not.toHaveBeenCalled();
    },
  );
});

type SdkMock = ReturnType<typeof vi.fn>;
type ChatClient = { client: { chat: { completions: { create: unknown } } } };

const chatResponse = {
  choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', index: 0 }],
  model: 'some-model',
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function anthropicMocked(): { provider: Provider; sdk: SdkMock } {
  const sdk = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'ok' }],
    model: 'claude-sonnet-5-5',
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: 'end_turn',
  });
  const provider = new AnthropicProvider({ apiKey: 'test-key' });
  (provider as unknown as { client: { messages: { create: unknown } } }).client.messages.create =
    sdk;
  return { provider, sdk };
}

function chatMocked(provider: Provider): { provider: Provider; sdk: SdkMock } {
  const sdk = vi.fn().mockResolvedValue(chatResponse);
  (provider as unknown as ChatClient).client.chat.completions.create = sdk;
  return { provider, sdk };
}

function geminiMocked(): { provider: Provider; sdk: SdkMock } {
  const sdk = vi.fn().mockResolvedValue({
    text: 'ok',
    candidates: [{ finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  });
  const provider = new GeminiProvider({ apiKey: 'test-key' });
  (
    provider as unknown as { client: { models: { generateContent: unknown } } }
  ).client.models.generateContent = sdk;
  return { provider, sdk };
}

const vendors: Array<[string, () => { provider: Provider; sdk: SdkMock }]> = [
  ['anthropic', anthropicMocked],
  ['openai', () => chatMocked(new OpenAIProvider({ apiKey: 'test-key' }))],
  ['ollama', () => chatMocked(new OllamaProvider())],
  ['gemini', geminiMocked],
];

describe.each(vendors)('RedactingProvider around the %s provider', (_name, make) => {
  it('keeps the secret out of everything handed to the SDK', async () => {
    const { provider, sdk } = make();

    await new RedactingProvider(provider, redact).complete(leakyMessages, { stop: [SECRET] });

    expect(sdk).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(sdk.mock.calls[0]);
    expect(sent).not.toContain(SECRET);
    expect(sent).toContain('[REDACTED:portal_pass]');
  });

  it('keeps the secret out of the SDK when a cache sits inside the wrapper', async () => {
    const { provider, sdk } = make();
    const wrapped = new RedactingProvider(new CachedProvider(provider), redact);

    await wrapped.complete(leakyMessages);

    expect(JSON.stringify(sdk.mock.calls[0])).not.toContain(SECRET);
  });

  it('keeps the secret out of the SDK when a cache sits outside the wrapper', async () => {
    const { provider, sdk } = make();
    const wrapped = new CachedProvider(new RedactingProvider(provider, redact));

    await wrapped.complete(leakyMessages);

    expect(JSON.stringify(sdk.mock.calls[0])).not.toContain(SECRET);
  });
});

describe('RedactingProvider with CachedProvider', () => {
  it('hits the cache for two requests that differ only in the secret value', async () => {
    const inner = stubProvider();
    const cached = new CachedProvider(inner);
    const first = new RedactingProvider(cached, redact);
    // A second run of the same workflow after the password was rotated.
    const second = new RedactingProvider(cached, (text) =>
      text.split('rotated-secret').join('[REDACTED:portal_pass]'),
    );

    await first.complete([{ role: 'user', content: `value ${SECRET}` }]);
    await second.complete([{ role: 'user', content: 'value rotated-secret' }]);

    expect(inner.complete).toHaveBeenCalledTimes(1);
    expect(cached.hits).toBe(1);
  });

  it('gives the cache store nothing that contains the secret', async () => {
    const written: unknown[] = [];
    const store: CacheStore = {
      get: () => undefined,
      set: (key, value) => {
        written.push(key, value);
      },
    };
    // An inner provider that echoes its input, as a worst case for the stored value.
    const echo: Provider = {
      name: 'echo',
      model: 'echo-model',
      complete: async (messages) => ({
        ...completion,
        content: messages.map((m) => m.content).join('\n'),
      }),
    };

    await new RedactingProvider(new CachedProvider(echo, { store }), redact).complete(
      leakyMessages,
    );

    expect(written).toHaveLength(2);
    expect(JSON.stringify(written)).not.toContain(SECRET);
  });
});
