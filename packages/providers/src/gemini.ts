import { GoogleGenAI, ApiError } from '@google/genai';
import type { Content } from '@google/genai';
import type { Message, CompleteOptions, Completion, ProviderConfig } from './types.js';
import { ProviderError, type ProviderErrorCode } from './types.js';
import type { Provider } from './types.js';

export interface GeminiConfig extends ProviderConfig {
  baseUrl?: string;
}

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_MAX_TOKENS = 16_000;

export class GeminiProvider implements Provider {
  readonly name = 'gemini';
  private readonly client: GoogleGenAI;
  private readonly model: string;

  constructor(config: GeminiConfig = {}) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.client = new GoogleGenAI({
      apiKey: config.apiKey,
      httpOptions: config.baseUrl ? { baseUrl: config.baseUrl } : undefined,
    });
  }

  async complete(messages: Message[], options?: CompleteOptions): Promise<Completion> {
    try {
      const { system, conversation } = splitSystem(messages);

      const response = await this.client.models.generateContent({
        model: this.model,
        contents: conversation,
        config: {
          systemInstruction: system || undefined,
          maxOutputTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
          stopSequences: options?.stop,
        },
      });

      return {
        content: response.text ?? '',
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
        model: this.model,
      };
    } catch (error) {
      throw toProviderError(error);
    }
  }
}

function splitSystem(messages: Message[]): { system: string | null; conversation: Content[] } {
  let i = 0;
  const systemParts: string[] = [];
  while (i < messages.length && messages[i]!.role === 'system') {
    systemParts.push(messages[i]!.content);
    i++;
  }

  const conversation: Content[] = messages.slice(i).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : null,
    conversation,
  };
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ApiError) {
    const code = classifyApiError(error.status, error.message);
    return new ProviderError(error.message, { code, provider: 'gemini', cause: error });
  }

  if (error instanceof Error && isConnectionError(error)) {
    return new ProviderError(error.message, { code: 'network', provider: 'gemini', cause: error });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(message, { code: 'unknown', provider: 'gemini', cause: error });
}

function classifyApiError(status: number, message: string): ProviderErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 404) return 'model_not_found';
  if (status >= 500) return 'server_error';
  if (status === 400) {
    const lower = message.toLowerCase();
    if (lower.includes('context') || lower.includes('token limit')) return 'context_length';
    if (lower.includes('model')) return 'model_not_found';
  }
  return 'unknown';
}

function isConnectionError(error: Error): boolean {
  const name = error.name;
  return (
    name === 'ConnectionError' ||
    name === 'RequestTimeoutError' ||
    name === 'RequestAbortedError' ||
    error.message.includes('ECONNREFUSED') ||
    error.message.includes('ENOTFOUND') ||
    error.message.includes('fetch failed')
  );
}
