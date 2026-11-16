import OpenAI from 'openai';
import type { Message, CompleteOptions, Completion, ProviderConfig, StopReason } from './types.js';
import { ProviderError, type ProviderErrorCode } from './types.js';
import type { Provider } from './types.js';
import { withDeadline } from './deadline.js';

export interface OpenAIConfig extends ProviderConfig {
  baseUrl?: string;
}

const DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_MAX_TOKENS = 16_000;

export class OpenAIProvider implements Provider {
  readonly name: string;
  protected readonly client: OpenAI;
  protected readonly model: string;

  constructor(config: OpenAIConfig = {}, providerName = 'openai') {
    this.name = providerName;
    this.model = config.model ?? DEFAULT_MODEL;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
  }

  async complete(messages: Message[], options?: CompleteOptions): Promise<Completion> {
    try {
      const response = await withDeadline(this.name, options, (signal) =>
        this.client.chat.completions.create(
          {
            model: this.model,
            max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
            stop: options?.stop,
            messages: messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
          },
          // Passed only when there is a signal, so a call with no deadline
          // reaches the SDK exactly as it did before.
          ...(signal ? [{ signal }] : []),
        ),
      );

      const choice = response.choices[0];
      const content = choice?.message?.content ?? '';

      return {
        content,
        stopReason: toStopReason(choice?.finish_reason),
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
        model: response.model,
      };
    } catch (error) {
      throw toProviderError(error, this.name);
    }
  }
}

function toStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    // The chat completions API reports a caller's stop sequence as `stop`
    // too, so the two cannot be told apart here.
    case 'stop':
      return 'end';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      // `tool_calls` and `function_call` cannot happen here because no tools
      // are sent. They, a missing choice, and any value an OpenAI-compatible
      // server invents are `other`.
      return 'other';
  }
}

function toProviderError(error: unknown, provider: string): ProviderError {
  // Timeouts and caller aborts are already classified by `withDeadline`.
  if (error instanceof ProviderError) return error;
  if (error instanceof OpenAI.AuthenticationError) {
    return new ProviderError(error.message, { code: 'auth', provider, cause: error });
  }
  if (error instanceof OpenAI.RateLimitError) {
    return new ProviderError(error.message, { code: 'rate_limit', provider, cause: error });
  }
  if (error instanceof OpenAI.BadRequestError) {
    const code = classifyBadRequest(error.message);
    return new ProviderError(error.message, { code, provider, cause: error });
  }
  if (error instanceof OpenAI.NotFoundError) {
    return new ProviderError(error.message, { code: 'model_not_found', provider, cause: error });
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new ProviderError(error.message, { code: 'network', provider, cause: error });
  }
  if (error instanceof OpenAI.APIError) {
    const code: ProviderErrorCode =
      error.status !== undefined && error.status >= 500 ? 'server_error' : 'unknown';
    return new ProviderError(error.message, { code, provider, cause: error });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(message, { code: 'unknown', provider, cause: error });
}

function classifyBadRequest(message: string): ProviderErrorCode {
  const lower = message.toLowerCase();
  if (lower.includes('context') || lower.includes('maximum context length'))
    return 'context_length';
  if (lower.includes('model')) return 'model_not_found';
  return 'unknown';
}
