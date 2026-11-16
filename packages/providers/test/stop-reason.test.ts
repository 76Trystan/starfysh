import { describe, it, expect, vi } from 'vitest';
import {
  AnthropicProvider,
  CachedProvider,
  GeminiProvider,
  OllamaProvider,
  OpenAIProvider,
} from '../src/index.js';
import type { Provider, StopReason } from '../src/index.js';

const msgs = [{ role: 'user' as const, content: 'Hi' }];

function anthropicWith(stopReason: string | null): Provider {
  const provider = new AnthropicProvider({ apiKey: 'test-key' });
  (provider as unknown as { client: { messages: { create: unknown } } }).client.messages.create = vi
    .fn()
    .mockResolvedValue({
      content: [{ type: 'text', text: '{"op":"replace"' }],
      model: 'claude-sonnet-5-5',
      usage: { input_tokens: 42, output_tokens: 10 },
      stop_reason: stopReason,
    });
  return provider;
}

type ChatClient = { client: { chat: { completions: { create: unknown } } } };

function chatResponse(finishReason: string | null | undefined) {
  return {
    choices:
      finishReason === undefined
        ? []
        : [
            {
              message: { role: 'assistant', content: '{"op":"replace"' },
              finish_reason: finishReason,
              index: 0,
            },
          ],
    model: 'some-model',
    usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
  };
}

function openaiWith(finishReason: string | null | undefined): Provider {
  const provider = new OpenAIProvider({ apiKey: 'test-key' });
  (provider as unknown as ChatClient).client.chat.completions.create = vi
    .fn()
    .mockResolvedValue(chatResponse(finishReason));
  return provider;
}

function ollamaWith(finishReason: string | null | undefined): Provider {
  const provider = new OllamaProvider();
  (provider as unknown as ChatClient).client.chat.completions.create = vi
    .fn()
    .mockResolvedValue(chatResponse(finishReason));
  return provider;
}

function geminiWith(finishReason: string | undefined): Provider {
  const provider = new GeminiProvider({ apiKey: 'test-key' });
  (
    provider as unknown as { client: { models: { generateContent: unknown } } }
  ).client.models.generateContent = vi.fn().mockResolvedValue({
    text: '{"op":"replace"',
    candidates: finishReason === undefined ? undefined : [{ finishReason }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 6 },
  });
  return provider;
}

async function stopReasonOf(provider: Provider): Promise<StopReason> {
  return (await provider.complete(msgs)).stopReason;
}

describe('Completion.stopReason', () => {
  describe('AnthropicProvider', () => {
    it.each<[string | null, StopReason]>([
      ['end_turn', 'end'],
      ['max_tokens', 'max_tokens'],
      ['model_context_window_exceeded', 'max_tokens'],
      ['stop_sequence', 'stop_sequence'],
      ['refusal', 'refusal'],
      ['tool_use', 'other'],
      ['pause_turn', 'other'],
      ['a_reason_added_later', 'other'],
      [null, 'other'],
    ])('maps stop_reason %s to %s', async (vendor, expected) => {
      expect(await stopReasonOf(anthropicWith(vendor))).toBe(expected);
    });
  });

  describe('OpenAIProvider', () => {
    it.each<[string | null | undefined, StopReason]>([
      ['stop', 'end'],
      ['length', 'max_tokens'],
      ['content_filter', 'refusal'],
      ['tool_calls', 'other'],
      ['function_call', 'other'],
      [null, 'other'],
    ])('maps finish_reason %s to %s', async (vendor, expected) => {
      expect(await stopReasonOf(openaiWith(vendor))).toBe(expected);
    });

    it('reports other when the response has no choices', async () => {
      expect(await stopReasonOf(openaiWith(undefined))).toBe('other');
    });
  });

  describe('OllamaProvider', () => {
    it('reports end for a finished answer', async () => {
      expect(await stopReasonOf(ollamaWith('stop'))).toBe('end');
    });

    it('reports max_tokens for a truncated answer', async () => {
      expect(await stopReasonOf(ollamaWith('length'))).toBe('max_tokens');
    });

    it('reports other for a finish reason a local server made up', async () => {
      expect(await stopReasonOf(ollamaWith('eos_token'))).toBe('other');
    });
  });

  describe('GeminiProvider', () => {
    it.each<[string, StopReason]>([
      ['STOP', 'end'],
      ['MAX_TOKENS', 'max_tokens'],
      ['SAFETY', 'refusal'],
      ['RECITATION', 'refusal'],
      ['BLOCKLIST', 'refusal'],
      ['PROHIBITED_CONTENT', 'refusal'],
      ['SPII', 'refusal'],
      ['FINISH_REASON_UNSPECIFIED', 'other'],
      ['MALFORMED_FUNCTION_CALL', 'other'],
      ['OTHER', 'other'],
    ])('maps finishReason %s to %s', async (vendor, expected) => {
      expect(await stopReasonOf(geminiWith(vendor))).toBe(expected);
    });

    it('reports other when the response has no candidates', async () => {
      expect(await stopReasonOf(geminiWith(undefined))).toBe('other');
    });
  });

  describe('CachedProvider', () => {
    it('returns the stop reason on a cache hit, so a cached truncation still reads as truncated', async () => {
      const cached = new CachedProvider(anthropicWith('max_tokens'));

      const first = await cached.complete(msgs);
      const second = await cached.complete(msgs);

      expect(cached.hits).toBe(1);
      expect(first.stopReason).toBe('max_tokens');
      expect(second.stopReason).toBe('max_tokens');
    });
  });
});
