import Anthropic from '@anthropic-ai/sdk';
import type { Message, CompleteOptions, Completion, ProviderConfig, StopReason } from './types.js';
import { ProviderError, type ProviderErrorCode } from './types.js';
import type { Provider } from './types.js';

export interface AnthropicConfig extends ProviderConfig {
  baseUrl?: string;
}

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const DEFAULT_MAX_TOKENS = 16_000;

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(config: AnthropicConfig = {}) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
  }

  async complete(messages: Message[], options?: CompleteOptions): Promise<Completion> {
    const { system, conversation } = splitSystem(messages);

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
        stop_sequences: options?.stop,
        system: system ?? undefined,
        messages: conversation.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      return {
        content: text,
        stopReason: toStopReason(response.stop_reason),
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        model: response.model,
      };
    } catch (error) {
      throw toProviderError(error);
    }
  }
}

function toStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
      return 'end';
    case 'max_tokens':
    // The output hit the context window before it hit `max_tokens`. Either
    // way the content was cut off.
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'refusal':
      return 'refusal';
    default:
      // `tool_use` and `pause_turn` cannot happen here because no tools are
      // sent. They, a missing reason, and any value added later are `other`.
      return 'other';
  }
}

function splitSystem(messages: Message[]): {
  system: string | null;
  conversation: Message[];
} {
  if (messages.length === 0) return { system: null, conversation: [] };

  if (messages[0]!.role === 'system') {
    const systemParts: string[] = [];
    let i = 0;
    while (i < messages.length && messages[i]!.role === 'system') {
      systemParts.push(messages[i]!.content);
      i++;
    }
    return {
      system: systemParts.join('\n\n'),
      conversation: messages.slice(i),
    };
  }

  return { system: null, conversation: messages };
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof Anthropic.AuthenticationError) {
    return new ProviderError(error.message, { code: 'auth', provider: 'anthropic', cause: error });
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ProviderError(error.message, {
      code: 'rate_limit',
      provider: 'anthropic',
      cause: error,
    });
  }
  if (error instanceof Anthropic.BadRequestError) {
    const code = classifyBadRequest(error.message);
    return new ProviderError(error.message, { code, provider: 'anthropic', cause: error });
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new ProviderError(error.message, {
      code: 'model_not_found',
      provider: 'anthropic',
      cause: error,
    });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderError(error.message, {
      code: 'network',
      provider: 'anthropic',
      cause: error,
    });
  }
  if (error instanceof Anthropic.APIError) {
    const code: ProviderErrorCode =
      error.status && error.status >= 500 ? 'server_error' : 'unknown';
    return new ProviderError(error.message, { code, provider: 'anthropic', cause: error });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(message, { code: 'unknown', provider: 'anthropic', cause: error });
}

function classifyBadRequest(message: string): ProviderErrorCode {
  const lower = message.toLowerCase();
  if (
    lower.includes('context') ||
    lower.includes('too many tokens') ||
    lower.includes('max_tokens')
  )
    return 'context_length';
  if (lower.includes('model')) return 'model_not_found';
  return 'unknown';
}
