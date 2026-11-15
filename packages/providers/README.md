# @sfysh/providers

Model provider abstraction for Starfysh. Defines a `Provider` interface that Anthropic, OpenAI, and local-model backends (Ollama) each satisfy, so the healer and future authoring agent can swap providers without code changes.

## Usage

```ts
import type { Provider, Message } from '@sfysh/providers';

// The healer builds messages from the failed step context
const messages: Message[] = [
  { role: 'system', content: 'You are a Starfysh healing agent...' },
  { role: 'user', content: 'Step click_003 failed. Accessibility snapshot: ...' },
];

const result = await provider.complete(messages, { temperature: 0 });
// result.content  -> the model's patch suggestion
// result.usage    -> { inputTokens, outputTokens } for cost tracking
// result.model    -> resolved model identifier
```

## Provider interface

Every provider implements:

- `name: string` - human-readable provider name (e.g. `'anthropic'`, `'openai'`, `'ollama'`).
- `complete(messages, options?)` - send a conversation and receive a `Completion`.

`CompleteOptions` supports `temperature`, `maxTokens`, and `stop` sequences. Providers apply their own defaults when these are omitted.

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

Private workspace package. No concrete provider implementations yet. The Anthropic provider lands next, followed by OpenAI and Ollama.
