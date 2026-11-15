import OpenAI from 'openai';
import type { Message, CompleteOptions, Completion, ProviderConfig } from './types.js';
import { ProviderError, type ProviderErrorCode } from './types.js';
import type { Provider } from './types.js';

export interface OpenAIConfig extends ProviderConfig {
  baseUrl?: string;
}

const DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_MAX_TOKENS = 16_000;

export class OpenAIProvider implements Provider {
  readonly name = 'openai';
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(config: OpenAIConfig = {}) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
  }

  async complete(messages: Message[], options?: CompleteOptions): Promise<Completion> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
        stop: options?.stop,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });

      const choice = response.choices[0];
      const content = choice?.message?.content ?? '';

      return {
        content,
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
        model: response.model,
      };
    } catch (error) {
      throw toProviderError(error);
    }
  }
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof OpenAI.AuthenticationError) {
    return new ProviderError(error.message, { code: 'auth', provider: 'openai', cause: error });
  }
  if (error instanceof OpenAI.RateLimitError) {
    return new ProviderError(error.message, {
      code: 'rate_limit',
      provider: 'openai',
      cause: error,
    });
  }
  if (error instanceof OpenAI.BadRequestError) {
    const code = classifyBadRequest(error.message);
    return new ProviderError(error.message, { code, provider: 'openai', cause: error });
  }
  if (error instanceof OpenAI.NotFoundError) {
    return new ProviderError(error.message, {
      code: 'model_not_found',
      provider: 'openai',
      cause: error,
    });
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new ProviderError(error.message, {
      code: 'network',
      provider: 'openai',
      cause: error,
    });
  }
  if (error instanceof OpenAI.APIError) {
    const code: ProviderErrorCode =
      error.status !== undefined && error.status >= 500 ? 'server_error' : 'unknown';
    return new ProviderError(error.message, { code, provider: 'openai', cause: error });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(message, { code: 'unknown', provider: 'openai', cause: error });
}

function classifyBadRequest(message: string): ProviderErrorCode {
  const lower = message.toLowerCase();
  if (lower.includes('context') || lower.includes('maximum context length'))
    return 'context_length';
  if (lower.includes('model')) return 'model_not_found';
  return 'unknown';
}
