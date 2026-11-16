# @sfysh/providers

Model provider abstraction for Starfysh. Defines a `Provider` interface that Anthropic, OpenAI, Gemini, and local-model backends (Ollama, LM Studio, vLLM) each satisfy, so the healer and future authoring agent can swap providers without code changes.

## Providers

| Class               | Backend                      | Default model       | SDK                 |
| ------------------- | ---------------------------- | ------------------- | ------------------- |
| `AnthropicProvider` | Anthropic Messages API       | `claude-sonnet-5-5` | `@anthropic-ai/sdk` |
| `OpenAIProvider`    | OpenAI Chat Completions API  | `gpt-4o`            | `openai`            |
| `GeminiProvider`    | Google Gemini API            | `gemini-2.5-flash`  | `@google/genai`     |
| `OllamaProvider`    | Any OpenAI-compatible server | `llama3.2`          | `openai` (reused)   |

`OllamaProvider` extends `OpenAIProvider` with local defaults (`localhost:11434/v1`). It works with any server that exposes an OpenAI-compatible chat completions endpoint.

## Usage

```ts
import { AnthropicProvider } from '@sfysh/providers';
import type { Message } from '@sfysh/providers';

const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY });

const messages: Message[] = [
  { role: 'system', content: 'You are a Starfysh healing agent...' },
  { role: 'user', content: 'Step click_003 failed. Accessibility snapshot: ...' },
];

const result = await provider.complete(messages, { maxTokens: 4096 });
// result.content  -> the model's patch suggestion
// result.usage    -> { inputTokens, outputTokens } for cost tracking
// result.model    -> resolved model identifier
```

## Caching

`CachedProvider` wraps any provider and deduplicates identical requests using a content hash (FNV-1a over the serialised messages and options).

```ts
import { CachedProvider, AnthropicProvider } from '@sfysh/providers';

const provider = new CachedProvider(new AnthropicProvider());

await provider.complete(messages); // calls Anthropic
await provider.complete(messages); // returns cached result

provider.hits; // 1
provider.misses; // 1
```

The default store is in-memory. Plug in a custom `CacheStore` (with `get`/`set` methods) for disk or Redis backing.

## Provider interface

Every provider implements:

- `name: string`, the provider identifier (e.g. `'anthropic'`, `'openai'`, `'gemini'`, `'ollama'`).
- `complete(messages, options?)`, send a conversation and receive a `Completion`.

`CompleteOptions` supports `maxTokens` and `stop` sequences. Providers apply their own defaults when these are omitted.

## Stop reason

Every `Completion` carries a `stopReason` saying why the model stopped writing. Check it before parsing `content`: output that was cut off can still look well formed.

| `stopReason`    | Meaning                                                                   | Content complete |
| --------------- | ------------------------------------------------------------------------- | ---------------- |
| `end`           | The model finished its answer.                                            | Yes              |
| `stop_sequence` | One of the caller's `stop` strings was produced.                          | Yes              |
| `max_tokens`    | The output hit `maxTokens` or the model's context window.                 | No               |
| `refusal`       | The model declined, or a safety filter cut the output.                    | No               |
| `other`         | Anything else, including a reason the vendor did not report or a new one. | Unknown          |

```ts
const completion = await provider.complete(messages, { maxTokens: 2_000 });
if (completion.stopReason !== 'end' && completion.stopReason !== 'stop_sequence') {
  throw new Error(`Incomplete model output: ${completion.stopReason}`);
}
```

Only Anthropic reports a stop sequence separately. OpenAI-compatible APIs (including Ollama) and Gemini report it the same way as a natural finish, so those providers return `end` for both. A cached completion keeps its stop reason, so a truncated answer served from `CachedProvider` still reads as truncated.

## Error handling

Provider failures throw `ProviderError` with a typed `code` field:

| Code              | Meaning                                  | Retryable |
| ----------------- | ---------------------------------------- | --------- |
| `auth`            | Bad or missing API key                   | No        |
| `rate_limit`      | Rate limited by the API                  | Yes       |
| `context_length`  | Input exceeds the model's context window | No        |
| `model_not_found` | Requested model does not exist           | No        |
| `server_error`    | 5xx from the API                         | Yes       |
| `network`         | Connection or DNS failure                | No        |
| `unknown`         | Unclassified error                       | No        |

The `retryable` flag lets callers decide whether to retry without inspecting the code directly.

## Status

Private workspace package (0.0.0). All four providers, the cache layer, and 108 tests are implemented.
