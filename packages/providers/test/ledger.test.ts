import { describe, it, expect, vi } from 'vitest';
import {
  CachedProvider,
  costOf,
  MemoryUsageLedger,
  MeteredProvider,
  ProviderError,
  sumUsage,
} from '../src/index.js';
import type { Completion, Message, PriceTable, Provider } from '../src/index.js';

const msgs: Message[] = [{ role: 'user', content: 'Hello' }];
const at = new Date('2026-11-17T09:00:00Z');

function stubProvider(
  usage = { inputTokens: 1000, outputTokens: 200 },
  answeredModel = 'stub-model-2026-11-01',
): Provider {
  return {
    name: 'stub',
    model: 'stub-model',
    complete: vi.fn().mockResolvedValue({
      content: 'ok',
      stopReason: 'end',
      usage,
      model: answeredModel,
    } satisfies Completion),
  };
}

// Round numbers for the arithmetic, not real prices.
const prices: PriceTable = { 'stub-model': { inputPerMTok: 2, outputPerMTok: 10 } };

describe('MeteredProvider: recording', () => {
  it('records every completed call with tokens, cost, model and label', async () => {
    const ledger = new MemoryUsageLedger();
    const metered = new MeteredProvider(stubProvider(), {
      ledger,
      prices,
      label: 'wf_orders',
      now: () => at,
    });

    await metered.complete(msgs);

    expect(ledger.entries).toEqual([
      {
        at,
        provider: 'stub',
        model: 'stub-model-2026-11-01',
        inputTokens: 1000,
        outputTokens: 200,
        costUsd: (1000 * 2 + 200 * 10) / 1_000_000,
        label: 'wf_orders',
      },
    ]);
  });

  it('prices on the answering model first, then the configured one', async () => {
    const ledger = new MemoryUsageLedger();
    const table: PriceTable = {
      ...prices,
      'stub-model-2026-11-01': { inputPerMTok: 1, outputPerMTok: 1 },
    };
    await new MeteredProvider(stubProvider(), { ledger, prices: table }).complete(msgs);
    expect(ledger.entries[0]!.costUsd).toBe(1200 / 1_000_000);
  });

  it('leaves cost out when no price is known, and counts the call as unpriced', async () => {
    const ledger = new MemoryUsageLedger();
    await new MeteredProvider(stubProvider(), { ledger }).complete(msgs);
    expect(ledger.entries[0]).not.toHaveProperty('costUsd');
    expect(ledger.totals()).toEqual({
      calls: 1,
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0,
      unpricedCalls: 1,
    });
  });

  it('records nothing for a failed call', async () => {
    const ledger = new MemoryUsageLedger();
    const inner: Provider = {
      name: 'failing',
      model: 'm',
      complete: vi.fn().mockRejectedValue(new Error('boom')),
    };
    await expect(new MeteredProvider(inner, { ledger }).complete(msgs)).rejects.toThrow('boom');
    expect(ledger.entries).toHaveLength(0);
  });

  it('passes on name and model, and makes its ledger available', () => {
    const metered = new MeteredProvider(stubProvider());
    expect(metered.name).toBe('stub');
    expect(metered.model).toBe('stub-model');
    expect(metered.ledger).toBeInstanceOf(MemoryUsageLedger);
  });

  it('does not see cache hits when it sits inside the cache', async () => {
    const ledger = new MemoryUsageLedger();
    const provider = new CachedProvider(new MeteredProvider(stubProvider(), { ledger }));
    await provider.complete(msgs);
    await provider.complete(msgs);
    expect(ledger.entries).toHaveLength(1);
  });
});

describe('MeteredProvider: budget', () => {
  it('refuses a call once the token budget is spent, without calling the provider', async () => {
    const inner = stubProvider();
    const metered = new MeteredProvider(inner, { budget: { maxTokens: 1200 } });

    await metered.complete(msgs);
    const error = await metered.complete(msgs).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe('budget_exceeded');
    expect((error as ProviderError).retryable).toBe(false);
    expect(inner.complete).toHaveBeenCalledTimes(1);
  });

  it('lowers maxTokens to what is left of the token budget', async () => {
    const inner = stubProvider();
    const metered = new MeteredProvider(inner, { budget: { maxTokens: 3000 } });

    await metered.complete(msgs, { maxTokens: 5000 }); // nothing used yet: lowered to 3000
    await metered.complete(msgs, { maxTokens: 100, timeoutMs: 10 }); // 1800 left: kept
    await metered.complete(msgs); // 600 left, none asked: set to 600

    const calls = (inner.complete as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map((c) => c[1])).toEqual([
      { maxTokens: 3000 },
      { maxTokens: 100, timeoutMs: 10 },
      { maxTokens: 600 },
    ]);
  });

  it('passes options through untouched when there is no token budget', async () => {
    const inner = stubProvider();
    const options = { maxTokens: 5000, signal: new AbortController().signal };
    await new MeteredProvider(inner, { prices, budget: { maxUsd: 1 } }).complete(msgs, options);
    expect((inner.complete as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe(options);
  });

  it('refuses a call once the dollar budget is spent', async () => {
    const inner = stubProvider();
    // Each call costs $0.004.
    const metered = new MeteredProvider(inner, { prices, budget: { maxUsd: 0.008 } });

    await metered.complete(msgs);
    await metered.complete(msgs);
    await expect(metered.complete(msgs)).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(inner.complete).toHaveBeenCalledTimes(2);
  });

  it('shares a budget between providers that share a ledger', async () => {
    const ledger = new MemoryUsageLedger();
    const a = new MeteredProvider(stubProvider(), { ledger, budget: { maxTokens: 1000 } });
    const b = new MeteredProvider(stubProvider(), { ledger, budget: { maxTokens: 1000 } });

    await a.complete(msgs);
    await expect(b.complete(msgs)).rejects.toMatchObject({ code: 'budget_exceeded' });
  });

  it('refuses a dollar budget with no price for the model', () => {
    expect(() => new MeteredProvider(stubProvider(), { budget: { maxUsd: 1 } })).toThrow(TypeError);
  });

  it('refuses budgets and prices that are not positive numbers', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new MeteredProvider(stubProvider(), { budget: { maxTokens: bad } })).toThrow(
        RangeError,
      );
    }
    expect(
      () =>
        new MeteredProvider(stubProvider(), {
          prices: { 'stub-model': { inputPerMTok: -1, outputPerMTok: 1 } },
        }),
    ).toThrow(RangeError);
  });
});

describe('usage helpers', () => {
  it('costOf works in dollars per million tokens', () => {
    expect(costOf({ inputPerMTok: 3, outputPerMTok: 15 }, 1_000_000, 1_000_000)).toBe(18);
  });

  it('sumUsage adds up entries', () => {
    expect(
      sumUsage([
        { at, provider: 'p', model: 'm', inputTokens: 1, outputTokens: 2, costUsd: 0.5 },
        { at, provider: 'p', model: 'm', inputTokens: 3, outputTokens: 4 },
      ]),
    ).toEqual({ calls: 2, inputTokens: 4, outputTokens: 6, costUsd: 0.5, unpricedCalls: 1 });
  });
});
