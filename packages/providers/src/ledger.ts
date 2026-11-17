// A record of what model calls used, and a budget that stops calls once
// it is spent.
//
// `MeteredProvider` wraps a provider. Every completed call is written to a
// `UsageLedger` with its token counts and, when the caller gave a price for
// the model, its cost. Before each call the ledger's totals are checked
// against the budget; a spent budget rejects the call with a
// `budget_exceeded` error and nothing is sent.
//
// Put it directly around the vendor provider, inside any `CachedProvider`:
//
//     new RedactingProvider(new CachedProvider(new MeteredProvider(vendor, opts)), redact)
//
// so a cache hit, which costs nothing, is neither recorded nor refused.
//
// Prices are supplied by the caller. Vendor prices change, and a stale
// built-in table would make the budget wrong without anyone noticing.

import type { CompleteOptions, Completion, Message, Provider } from './types.js';
import { ProviderError } from './types.js';

/** US dollars per million tokens. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** Prices by model name, as the vendor reports it in `Completion.model` or as configured on the provider. */
export type PriceTable = Readonly<Record<string, ModelPrice>>;

export interface UsageEntry {
  /** When the call finished. */
  at: Date;
  provider: string;
  /** The model that answered, from the completion. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Cost in US dollars. Absent when no price was known for the model. */
  costUsd?: number;
  /** Free-form label from `MeteredProviderConfig.label`, such as a workflow id. */
  label?: string;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum over the calls that had a price. */
  costUsd: number;
  /** Calls with no price, which `costUsd` leaves out. */
  unpricedCalls: number;
}

export interface UsageLedger {
  record(entry: UsageEntry): void;
  totals(): UsageTotals;
}

/** A ledger held in memory. */
export class MemoryUsageLedger implements UsageLedger {
  private readonly list: UsageEntry[] = [];

  record(entry: UsageEntry): void {
    this.list.push({ ...entry });
  }

  totals(): UsageTotals {
    return sumUsage(this.list);
  }

  /** Every entry, oldest first. */
  get entries(): readonly UsageEntry[] {
    return this.list;
  }
}

/** Add up a list of entries. */
export function sumUsage(entries: Iterable<UsageEntry>): UsageTotals {
  const totals: UsageTotals = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    unpricedCalls: 0,
  };
  for (const e of entries) {
    totals.calls++;
    totals.inputTokens += e.inputTokens;
    totals.outputTokens += e.outputTokens;
    if (e.costUsd === undefined) totals.unpricedCalls++;
    else totals.costUsd += e.costUsd;
  }
  return totals;
}

/** Cost of one call in US dollars. */
export function costOf(price: ModelPrice, inputTokens: number, outputTokens: number): number {
  return (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;
}

export interface UsageBudget {
  /** Most input plus output tokens across every call in the ledger. */
  maxTokens?: number;
  /** Most US dollars across every call in the ledger. Needs a price for the configured model. */
  maxUsd?: number;
}

export interface MeteredProviderConfig {
  /** Where calls are recorded. Default: a new `MemoryUsageLedger`. Share one ledger between providers to share a budget. */
  ledger?: UsageLedger;
  /** Limits over the ledger's totals. Default: none, which only records. */
  budget?: UsageBudget;
  prices?: PriceTable;
  /** Copied onto every entry. */
  label?: string;
  /** Clock for `UsageEntry.at`. Tests pass a fixed one. */
  now?: () => Date;
}

export class MeteredProvider implements Provider {
  readonly name: string;
  readonly model: string | undefined;
  readonly ledger: UsageLedger;
  private readonly inner: Provider;
  private readonly budget: UsageBudget;
  private readonly prices: PriceTable;
  private readonly label: string | undefined;
  private readonly now: () => Date;

  constructor(inner: Provider, config: MeteredProviderConfig = {}) {
    this.name = inner.name;
    this.model = inner.model;
    this.inner = inner;
    this.ledger = config.ledger ?? new MemoryUsageLedger();
    this.budget = config.budget ?? {};
    this.prices = config.prices ?? {};
    this.label = config.label;
    this.now = config.now ?? (() => new Date());

    for (const [name, value] of Object.entries(this.budget)) {
      if (
        value !== undefined &&
        !(typeof value === 'number' && value > 0 && Number.isFinite(value))
      ) {
        throw new RangeError(`Budget ${name} must be a positive number, not ${String(value)}.`);
      }
    }
    for (const [model, price] of Object.entries(this.prices)) {
      for (const rate of [price.inputPerMTok, price.outputPerMTok]) {
        if (!(rate >= 0 && Number.isFinite(rate))) {
          throw new RangeError(
            `Price for ${model} must be a non-negative number per million tokens.`,
          );
        }
      }
    }
    // A dollar budget with no price for the model would never be charged
    // against, so it would never stop anything. Refuse it up front.
    if (this.budget.maxUsd !== undefined && this.priceFor(undefined) === undefined) {
      throw new TypeError(
        `A maxUsd budget needs a price for the model, and there is none for '${inner.model ?? '(unknown model)'}'.`,
      );
    }
  }

  async complete(messages: Message[], options?: CompleteOptions): Promise<Completion> {
    const totals = this.ledger.totals();
    const spentTokens = totals.inputTokens + totals.outputTokens;
    const { maxTokens, maxUsd } = this.budget;
    if (maxTokens !== undefined && spentTokens >= maxTokens) {
      throw this.exceeded(`The token budget of ${maxTokens} is spent (${spentTokens} used).`);
    }
    if (maxUsd !== undefined && totals.costUsd >= maxUsd) {
      throw this.exceeded(
        `The budget of $${maxUsd} is spent ($${totals.costUsd.toFixed(4)} used).`,
      );
    }

    // Never let one answer run past what is left of the token budget. The
    // prompt can still overshoot it, because input tokens are only known
    // after the call; the next call is then refused.
    let callOptions = options;
    if (maxTokens !== undefined) {
      const left = maxTokens - spentTokens;
      const asked = options?.maxTokens;
      if (asked === undefined || asked > left) callOptions = { ...options, maxTokens: left };
    }

    const completion = await this.inner.complete(messages, callOptions);

    const price = this.priceFor(completion.model);
    const { inputTokens, outputTokens } = completion.usage;
    this.ledger.record({
      at: this.now(),
      provider: this.name,
      model: completion.model,
      inputTokens,
      outputTokens,
      ...(price !== undefined ? { costUsd: costOf(price, inputTokens, outputTokens) } : {}),
      ...(this.label !== undefined ? { label: this.label } : {}),
    });
    return completion;
  }

  /**
   * The price for the model that answered, falling back to the configured
   * model's. A vendor often answers an alias with a dated name, and a table
   * written for the alias should still apply.
   */
  private priceFor(answered: string | undefined): ModelPrice | undefined {
    if (answered !== undefined && Object.hasOwn(this.prices, answered))
      return this.prices[answered];
    if (this.model !== undefined && Object.hasOwn(this.prices, this.model)) {
      return this.prices[this.model];
    }
    return undefined;
  }

  private exceeded(message: string): ProviderError {
    return new ProviderError(`${message} No request was sent.`, {
      code: 'budget_exceeded',
      provider: this.name,
    });
  }
}
