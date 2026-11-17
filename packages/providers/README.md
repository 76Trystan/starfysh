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

`CachedProvider` wraps any provider and deduplicates identical requests. The key is SHA-256 over the provider name, the model, the messages, `maxTokens` and `stop`, so a completion from one model is never served for a request to another, even when two providers share a store.

```ts
import { CachedProvider, AnthropicProvider } from '@sfysh/providers';

const provider = new CachedProvider(new AnthropicProvider());

await provider.complete(messages); // calls Anthropic
await provider.complete(messages); // returns cached result

provider.hits; // 1
provider.misses; // 1
```

The default store is in-memory. Plug in a custom `CacheStore` (with `get`/`set` methods) for disk or Redis backing. Each stored `CacheEntry` holds the canonical request alongside the completion, and a hit is only served when that request matches exactly, so an edited, truncated or shared store cannot answer the wrong question. A lookup that finds someone else's entry counts as a miss and shows up in `provider.mismatches`.

The model comes from the inner provider's `model` property, which every vendor provider sets. If the inner provider has none (a test double, say), pass `{ model }` in the config; without either, the constructor throws rather than build a key that ignores the model.

## Usage and budgets

`MeteredProvider` records every completed call in a `UsageLedger` and refuses calls once a budget is spent.

```ts
import {
  CachedProvider,
  MemoryUsageLedger,
  MeteredProvider,
  AnthropicProvider,
} from '@sfysh/providers';

const ledger = new MemoryUsageLedger();
const provider = new CachedProvider(
  new MeteredProvider(new AnthropicProvider(), {
    ledger,
    prices: { 'claude-sonnet-5-5': { inputPerMTok: 0, outputPerMTok: 0 } }, // your current prices, in USD per million tokens
    budget: { maxTokens: 200_000, maxUsd: 5 },
    label: 'wf_orders',
  }),
);

ledger.totals(); // { calls, inputTokens, outputTokens, costUsd, unpricedCalls }
```

- **Recording.** Each entry has the time, provider, the model that answered, token counts, the cost when a price is known, and the label. A failed call records nothing.
- **Budget.** Before each call the ledger's totals are checked. A spent budget rejects with `ProviderError` code `budget_exceeded` and no request is sent. With a token budget, each call's `maxTokens` is lowered to what is left. The prompt can still take a call past the budget, because input tokens are only known afterwards; the next call is then refused. Share one ledger between providers to share one budget.
- **Prices.** There is no built-in price table, because vendor prices change and a stale one would make the budget silently wrong. Pass your own. A model is looked up by the name it answered with, then by the configured name. A `maxUsd` budget with no price for the model is refused at construction.
- **Order.** Put `MeteredProvider` directly around the vendor, inside `CachedProvider`, so a cache hit, which costs nothing, is neither recorded nor refused.

## Redaction

`RedactingProvider` wraps any provider and runs a function over every message's `content` and every `stop` string before the request is made. Give it the function that removes your secrets; in a Starfysh run that is the context's `redact`.

```ts
import { RedactingProvider, CachedProvider, AnthropicProvider } from '@sfysh/providers';

const provider = new RedactingProvider(new CachedProvider(new AnthropicProvider()), ctx.redact);

await provider.complete(messages); // the vendor and the cache only see redacted text
```

Put it outermost, around any `CachedProvider`, as above. The cache then only ever sees redacted text, so its keys and anything a custom `CacheStore` writes to disk hold no secrets, and two requests that differ only in a secret's value share one cache entry. With the cache on the outside the vendor is still protected, but the cache is keyed on the raw request.

This is a backstop. Whatever builds the prompt should already redact what goes into it; the wrapper is there for the code path that forgets. It fails closed: if the function throws or returns something that is not a string, the call rejects and no request is made. The response is not redacted, because the model was never shown the secret.

## Provider interface

Every provider implements:

- `name: string`, the provider identifier (e.g. `'anthropic'`, `'openai'`, `'gemini'`, `'ollama'`).
- `model?: string`, the model the provider asks for, as configured. Every vendor provider sets it, and the wrappers pass on their inner provider's.
- `complete(messages, options?)`, send a conversation and receive a `Completion`.

`CompleteOptions` supports `maxTokens` and `stop` sequences. Providers apply their own defaults when these are omitted. It also takes `timeoutMs` and `signal`, described next.

## Timeouts and cancellation

Pass `timeoutMs` to give up after a fixed time, `signal` to cancel from outside, or both.

```ts
const controller = new AbortController();

try {
  await provider.complete(messages, { timeoutMs: 60_000, signal: controller.signal });
} catch (error) {
  if (error instanceof ProviderError && error.code === 'timeout') {
    // Took longer than 60 seconds. Retryable.
  }
  if (error instanceof ProviderError && error.code === 'aborted') {
    // controller.abort() was called. The signal's reason is on error.cause.
  }
}
```

There is no default timeout. Without one, a call waits as long as the vendor SDK allows, which is ten minutes for the Anthropic and OpenAI clients. Anything that must not hang should set its own.

The signal is handed to the vendor SDK so the HTTP request is cancelled, and the call is also raced against the deadline inside this package. A backend that ignores the signal therefore still times out on schedule. A signal that is already aborted rejects before any request is made.

Neither option changes what the model is asked, so `CachedProvider` leaves both out of the cache key. A call that times out or is aborted is not cached.

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
| `timeout`         | The call ran longer than `timeoutMs`     | Yes       |
| `aborted`         | The caller's `signal` aborted the call   | No        |
| `budget_exceeded` | A `MeteredProvider` budget is spent      | No        |
| `unknown`         | Unclassified error                       | No        |

The `retryable` flag lets callers decide whether to retry without inspecting the code directly.

## Status

Private workspace package (0.0.0). All four providers, the cache layer, the redaction wrapper and the usage ledger are implemented and tested.
