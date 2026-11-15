import { OpenAIProvider, type OpenAIConfig } from './openai.js';

export interface OllamaConfig extends Omit<OpenAIConfig, 'apiKey'> {
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'http://localhost:11434/v1';
const DEFAULT_MODEL = 'llama3.2';

export class OllamaProvider extends OpenAIProvider {
  constructor(config: OllamaConfig = {}) {
    super(
      {
        apiKey: 'ollama',
        baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
        model: config.model ?? DEFAULT_MODEL,
      },
      'ollama',
    );
  }
}
