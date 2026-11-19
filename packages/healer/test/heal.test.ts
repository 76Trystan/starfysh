import { describe, expect, it } from 'vitest';
import type { StepPatch, Workflow } from '@sfysh/ir';
import { MemoryUsageLedger, MeteredProvider, ProviderError } from '@sfysh/providers';
import type { CompleteOptions, Completion, Provider } from '@sfysh/providers';
import { VaultSecretMissingError } from '@sfysh/runtime';
import type { Locator, Page } from '@sfysh/runtime';
import { interpretWorkflow, replay } from '@sfysh/verifier';
import type { ReplayOutcome } from '@sfysh/verifier';
import {
  DEFAULT_HEAL_LIMITS,
  DEFAULT_HEAL_MAX_TOKENS,
  heal,
  healRecord,
  HEAL_WINDOW_MS,
  MemoryHealHistory,
  patchClassOrder,
  renderReview,
  resolveHealLimits,
  SHADOW_AUTO_POLICY,
  shadowDecision,
} from '../src/index.js';
import type { HealInput, HealResult } from '../src/index.js';

type Loose = Record<string, unknown>;

const workflow = {
  irVersion: '1.0.0',
  id: 'wf_orders',
  name: 'Read the latest order',
  steps: [
    {
      id: 'nav_001',
      intent: 'Open the portal.',
      action: 'navigate',
      url: 'https://portal.example.com/',
    },
    {
      id: 'click_002',
      intent: 'Open the orders page.',
      action: 'click',
      target: { candidates: [{ kind: 'role', value: "link[name='Orders']" }] },
    },
    {
      id: 'extract_003',
      intent: 'Read the latest order number.',
      action: 'extract',
      target: { candidates: [{ kind: 'css', value: 'h1' }] },
      schema: { type: 'string' },
    },
  ],
} as unknown as Workflow;

interface Site {
  links: string[];
  heading: string;
  /** Text of the accessibility snapshot. */
  snapshot?: string;
  /** Message every click throws, whatever the target. */
  clickError?: string;
}

function timeout(message: string): Error {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

function sitePage(site: Site): Page {
  const locator = (exists: boolean, texts: string[] = []): Locator =>
    ({
      click: async () => {
        if (site.clickError !== undefined) throw timeout(site.clickError);
        if (!exists) throw timeout('locator.click: Timeout 30000ms exceeded.');
      },
      fill: async () => {},
      isVisible: async () => exists,
      count: async () => (exists ? 1 : 0),
      allTextContents: async () => texts,
      all: async () => [],
      locator: () => locator(false),
      nth: () => locator(exists, texts),
    }) as unknown as Locator;
  return {
    goto: async () => {},
    url: () => 'https://portal.example.com/',
    waitForTimeout: async () => {},
    locator: (selector: string) => locator(selector === 'h1', [site.heading]),
    getByRole: (_role: string, options?: { name?: string }) =>
      locator(site.links.includes(options?.name ?? '')),
    getByTestId: () => locator(false),
    getByText: () => locator(false),
    getByLabel: () => locator(false),
    snapshot: async () =>
      site.snapshot ??
      [...site.links.map((l) => `- link "${l}"`), `- heading "${site.heading}" [level=1]`].join(
        '\n',
      ),
  } as unknown as Page;
}

const oldSite: Site = { links: ['Orders'], heading: 'Order 1042' };
const newSite: Site = { links: ['My orders'], heading: 'Order 1042' };
const knownGood = { outputs: [{ extract_003: 'Order 1042' }] };

/** Run the original workflow once against a site and return the outcome. */
async function runOn(site: Site): Promise<ReplayOutcome> {
  const report = await replay(workflow, {
    pageFactory: () => sitePage(site),
    runner: interpretWorkflow,
    runs: 1,
  });
  return report.replays[0]!;
}

interface Call {
  options: CompleteOptions | undefined;
}

type Reply = string | Error;

/** A provider that answers from a list, one reply per call. */
function scripted(
  replies: Reply[],
  usage = { inputTokens: 1200, outputTokens: 90 },
): Provider & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    name: 'fake',
    calls,
    async complete(_messages, options) {
      calls.push({ options });
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (reply === undefined) throw new Error('no reply scripted');
      if (reply instanceof Error) throw reply;
      const completion: Completion = {
        content: reply,
        stopReason: 'end',
        usage,
        model: 'fake-model-2026',
      };
      return completion;
    },
  };
}

const click002 = (workflow.steps as unknown as Loose[])[1]!;

const selectorAnswer = (name = 'My orders') =>
  JSON.stringify({
    after: {
      ...click002,
      target: { candidates: [{ kind: 'role', value: `link[name='${name}']` }] },
    },
    rationale: 'The link was renamed.',
    confidence: 0.9,
  });

const insertAnswer = (name = 'Accept') =>
  JSON.stringify({
    step: {
      id: 'x',
      intent: 'Dismiss the banner.',
      action: 'click',
      target: { candidates: [{ kind: 'role', value: `link[name='${name}']` }] },
    },
    rationale: 'A banner now covers the link.',
    confidence: 0.6,
  });

const cannotHeal = JSON.stringify({ cannotHeal: true, rationale: 'Nothing on the page fits.' });

async function healOn(
  site: Site,
  provider: Provider,
  overrides: Partial<HealInput> = {},
): Promise<HealResult> {
  return heal({
    workflow,
    outcome: await runOn(site),
    knownGood,
    provider,
    redact: (text) => text,
    pageFactory: () => sitePage(site),
    history: new MemoryHealHistory(),
    ...overrides,
  });
}

describe('heal', () => {
  it('heals a renamed link and holds the patch for a person by default', async () => {
    const provider = scripted([selectorAnswer()]);
    const history = new MemoryHealHistory();
    const now = new Date('2026-11-17T08:00:00Z');
    const result = await healOn(newSite, provider, { history, now: () => now });

    expect(result.status).toBe('decided');
    if (result.status !== 'decided') return;
    expect(result.patchClass).toBe('selector');
    expect(result.decision.status).toBe('awaiting_approval');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.verification?.status).toBe('verified');
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 90 });
    expect(provider.calls).toHaveLength(1);
    expect(history.count(workflow.id, new Date(0))).toBe(1);
  });

  it('accepts without a person only under the opt-in auto policy', async () => {
    const result = await healOn(newSite, scripted([selectorAnswer()]), {
      policy: { mode: 'auto', minScore: 0.8 },
    });
    expect(result.status).toBe('decided');
    if (result.status !== 'decided') return;
    expect(result.decision.status).toBe('accepted');
  });

  it('routes a failure triage does not send to the healer, without a model call or a history entry', async () => {
    const provider = scripted([selectorAnswer()]);
    const history = new MemoryHealHistory();
    const failing: Page = {
      ...sitePage(newSite),
      goto: async () => {
        throw new VaultSecretMissingError('portal_pass');
      },
    } as Page;
    const report = await replay(workflow, {
      pageFactory: () => failing,
      runner: interpretWorkflow,
      runs: 1,
    });
    const result = await healOn(newSite, provider, { outcome: report.replays[0]!, history });

    expect(result).toMatchObject({ status: 'routed', route: 'reauthenticate' });
    expect(provider.calls).toHaveLength(0);
    expect(history.count(workflow.id, new Date(0))).toBe(0);
  });

  it('returns recovered when triage retries and the retry passes', async () => {
    const provider = scripted([selectorAnswer()]);
    const result = await healOn(newSite, provider, { retry: () => runOn(oldSite) });
    expect(result.status).toBe('recovered');
    expect(provider.calls).toHaveLength(0);
  });

  it('does not call a model without a page snapshot', async () => {
    const provider = scripted([selectorAnswer()]);
    const outcome = await runOn(newSite);
    delete outcome.snapshot;
    const result = await healOn(newSite, provider, { outcome });
    expect(result).toMatchObject({ status: 'no_evidence', reason: 'no_snapshot' });
    expect(provider.calls).toHaveLength(0);
  });

  it('refuses a run that did not fail', async () => {
    await expect(
      healOn(newSite, scripted([selectorAnswer()]), { outcome: await runOn(oldSite) }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  describe('heals per workflow per day', () => {
    const now = new Date('2026-11-17T08:00:00Z');

    it('stops before any model call once the workflow has used its heals for the last 24 hours', async () => {
      const history = new MemoryHealHistory();
      for (let i = 0; i < DEFAULT_HEAL_LIMITS.maxHealsPerWorkflowPerDay; i++) {
        history.record(workflow.id, new Date(now.getTime() - 60_000 * (i + 1)));
      }
      const provider = scripted([selectorAnswer()]);
      const result = await healOn(newSite, provider, { history, now: () => now });

      expect(result).toMatchObject({ status: 'capped', cap: 'heals_per_day', attempts: [] });
      expect(provider.calls).toHaveLength(0);
      expect(history.count(workflow.id, new Date(0))).toBe(3);
    });

    it('does not count heals older than the window, or heals of other workflows', async () => {
      const history = new MemoryHealHistory();
      history.record(workflow.id, new Date(now.getTime() - HEAL_WINDOW_MS - 1));
      history.record(workflow.id, new Date(now.getTime() - HEAL_WINDOW_MS - 2));
      history.record(workflow.id, new Date(now.getTime() - HEAL_WINDOW_MS - 3));
      for (let i = 0; i < 5; i++) history.record('wf_other', now);
      const result = await healOn(newSite, scripted([selectorAnswer()]), {
        history,
        now: () => now,
      });
      expect(result.status).toBe('decided');
    });

    it('counts a heal that found nothing', async () => {
      const history = new MemoryHealHistory();
      const result = await healOn(newSite, scripted([cannotHeal]), { history, now: () => now });
      expect(result.status).toBe('not_healed');
      expect(history.count(workflow.id, new Date(0))).toBe(1);
    });

    it('honours a lower daily limit', async () => {
      const history = new MemoryHealHistory();
      history.record(workflow.id, now);
      const result = await healOn(newSite, scripted([selectorAnswer()]), {
        history,
        now: () => now,
        limits: { maxHealsPerWorkflowPerDay: 1 },
      });
      expect(result).toMatchObject({ status: 'capped', cap: 'heals_per_day' });
    });
  });

  describe('attempts per failure', () => {
    it('stops after the attempt limit', async () => {
      const provider = scripted([cannotHeal]);
      const result = await healOn(newSite, provider, { limits: { maxAttemptsPerFailure: 1 } });
      expect(result).toMatchObject({ status: 'capped', cap: 'attempts' });
      expect(provider.calls).toHaveLength(1);
    });

    it('retries the same class after a transient provider error, within the limit', async () => {
      const provider = scripted([
        new ProviderError('slow', { code: 'timeout', retryable: true, provider: 'fake' }),
        new ProviderError('slow', { code: 'timeout', retryable: true, provider: 'fake' }),
        new ProviderError('slow', { code: 'timeout', retryable: true, provider: 'fake' }),
        selectorAnswer(),
      ]);
      const result = await healOn(newSite, provider);
      expect(result).toMatchObject({ status: 'capped', cap: 'attempts' });
      if (result.status !== 'capped') return;
      expect(result.attempts.map((a) => [a.patchClass, a.generated.status])).toEqual([
        ['selector', 'provider_error'],
        ['selector', 'provider_error'],
        ['selector', 'provider_error'],
      ]);
      expect(provider.calls).toHaveLength(3);
    });

    it('heals after one transient provider error', async () => {
      const provider = scripted([
        new ProviderError('slow', { code: 'timeout', retryable: true, provider: 'fake' }),
        selectorAnswer(),
      ]);
      const result = await healOn(newSite, provider);
      expect(result.status).toBe('decided');
      expect(provider.calls).toHaveLength(2);
    });

    it('stops at a provider error a retry will not fix', async () => {
      const provider = scripted([
        new ProviderError('bad key', { code: 'auth', retryable: false, provider: 'fake' }),
        selectorAnswer(),
      ]);
      const result = await healOn(newSite, provider);
      expect(result).toMatchObject({ status: 'not_healed', reason: 'provider_error' });
      expect(provider.calls).toHaveLength(1);
    });

    it('does not count a class that was refused before any call', async () => {
      // A failed navigate has no target, so the selector class is refused
      // without a call and the insert-step class still gets its attempt.
      // The site failure is pinned on the navigate step by hand: triage
      // classifies from the error, which stays a selector timeout.
      const outcome = await runOn(newSite);
      const error = { ...outcome.error!, stepId: 'nav_001' };
      Object.defineProperty(error, 'cause', { value: outcome.error!.cause, enumerable: false });
      const provider = scripted([cannotHeal]);
      const result = await healOn(newSite, provider, {
        outcome: { ...outcome, error },
        limits: { maxAttemptsPerFailure: 1 },
      });
      expect(result.status).toBe('not_healed');
      if (result.status !== 'not_healed') return;
      expect(result.attempts.map((a) => [a.patchClass, a.generated.status])).toEqual([
        ['selector', 'rejected'],
        ['insert_step', 'cannot_heal'],
      ]);
      expect(provider.calls).toHaveLength(1);
    });
  });

  describe('shared budget', () => {
    it('reports a spent MeteredProvider budget as a cap, after one call', async () => {
      const ledger = new MemoryUsageLedger();
      const provider = new MeteredProvider(scripted([cannotHeal]), {
        ledger,
        budget: { maxTokens: 1000 },
      });
      const result = await healOn(newSite, provider);

      expect(result).toMatchObject({ status: 'capped', cap: 'budget' });
      if (result.status !== 'capped') return;
      expect(result.attempts.map((a) => a.generated.status)).toEqual([
        'cannot_heal',
        'provider_error',
      ]);
      expect(ledger.entries).toHaveLength(1);
    });

    it('refuses the first call when the budget was spent by an earlier heal', async () => {
      const ledger = new MemoryUsageLedger();
      ledger.record({
        at: new Date(),
        provider: 'fake',
        model: 'fake-model-2026',
        inputTokens: 900,
        outputTokens: 100,
      });
      const inner = scripted([selectorAnswer()]);
      const result = await healOn(
        newSite,
        new MeteredProvider(inner, { ledger, budget: { maxTokens: 1000 } }),
      );
      expect(result).toMatchObject({ status: 'capped', cap: 'budget' });
      expect(inner.calls).toHaveLength(0);
    });
  });

  describe('tokens per heal', () => {
    it('stops before a call once the budget is spent', async () => {
      const provider = scripted([cannotHeal]);
      const result = await healOn(newSite, provider, { limits: { maxTokensPerHeal: 1000 } });
      expect(result).toMatchObject({ status: 'capped', cap: 'tokens' });
      if (result.status !== 'capped') return;
      expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 90 });
      expect(provider.calls).toHaveLength(1);
    });

    it('caps each answer at what is left of the budget', async () => {
      const provider = scripted([cannotHeal]);
      await healOn(newSite, provider, { limits: { maxTokensPerHeal: 2500 } });
      expect(provider.calls.map((c) => c.options?.maxTokens)).toEqual([
        DEFAULT_HEAL_MAX_TOKENS,
        2500 - 1290,
      ]);
    });

    it('sums usage across attempts', async () => {
      const result = await healOn(newSite, scripted([cannotHeal]));
      expect(result.status).toBe('not_healed');
      if (result.status !== 'not_healed') return;
      expect(result.usage).toEqual({ inputTokens: 2400, outputTokens: 180 });
    });
  });

  describe('patch class order', () => {
    it('tries new selectors first, then an inserted step', async () => {
      const provider = scripted([cannotHeal]);
      const result = await healOn(newSite, provider);
      expect(result).toMatchObject({ status: 'not_healed', reason: 'exhausted' });
      if (result.status !== 'not_healed') return;
      expect(result.attempts.map((a) => a.patchClass)).toEqual(['selector', 'insert_step']);
    });

    it('tries an inserted step first when the element was covered', () => {
      expect(
        patchClassOrder({
          message: 'locator.click: <div class="overlay"> intercepts pointer events',
        }),
      ).toEqual(['insert_step', 'selector']);
      expect(
        patchClassOrder({ message: 'locator.click: element is covered by another element.' }),
      ).toEqual(['insert_step', 'selector']);
      expect(patchClassOrder({ message: 'locator.click: Timeout 30000ms exceeded.' })).toEqual([
        'selector',
        'insert_step',
      ]);
    });

    it('moves on to an inserted step when the selector patch fails verification', async () => {
      // The selector the model offers does not exist, so its patch fails
      // every run; the inserted click on "Accept" is what the site needs.
      const site: Site = { links: ['Orders', 'Accept'], heading: 'Order 1042' };
      let accepted = false;
      const page = () => {
        const base = sitePage(site);
        return {
          ...base,
          getByRole: (role: string, options?: { name?: string }) => {
            const inner = base.getByRole(role as never, options as never);
            if (options?.name === 'Accept') {
              return { ...inner, click: async () => void (accepted = true) } as Locator;
            }
            if (options?.name === 'Orders') {
              return {
                ...inner,
                click: async () => {
                  if (!accepted) throw timeout('locator.click: Timeout 30000ms exceeded.');
                },
              } as Locator;
            }
            return inner;
          },
        } as Page;
      };
      const failed = await replay(workflow, {
        pageFactory: page,
        runner: interpretWorkflow,
        runs: 1,
      });
      const provider = scripted([selectorAnswer('Purchases'), insertAnswer('Accept')]);
      const result = await healOn(site, provider, {
        outcome: failed.replays[0]!,
        pageFactory: () => {
          accepted = false;
          return page();
        },
      });

      expect(result.status).toBe('decided');
      if (result.status !== 'decided') return;
      expect(result.patchClass).toBe('insert_step');
      expect(result.attempts.map((a) => [a.patchClass, a.verification?.status])).toEqual([
        ['selector', 'failed'],
        ['insert_step', 'verified'],
      ]);
      expect(result.decision.status).toBe('awaiting_approval');
      // A patch that failed verification has no shadow verdict; an
      // inserted step would never be accepted automatically.
      expect(result.attempts[0]!.shadow).toBeUndefined();
      expect(result.attempts[1]!.shadow).toMatchObject({ eligible: false });
      expect(result.attempts[1]!.shadow!.reasons).toContain('insert_step');
    });
  });

  describe('shadow mode', () => {
    it('records that the automatic rule would accept a strong selector patch, while a person still decides', async () => {
      const result = await healOn(newSite, scripted([selectorAnswer()]));
      expect(result.status).toBe('decided');
      if (result.status !== 'decided') return;
      expect(result.decision.status).toBe('awaiting_approval');
      expect(result.attempts[0]!.shadow).toEqual({
        policy: SHADOW_AUTO_POLICY,
        eligible: true,
        reasons: [],
      });
    });

    it('records why the rule would still hold a patch, under a stricter shadow policy', async () => {
      const result = await healOn(newSite, scripted([selectorAnswer()]), {
        shadowPolicy: { mode: 'auto', minScore: 1 },
      });
      if (result.status !== 'decided') throw new Error('expected a decision');
      expect(result.attempts[0]!.shadow).toMatchObject({
        eligible: false,
        reasons: ['score_below_threshold'],
      });
    });

    it('never shows the shadow verdict in the review a person reads', async () => {
      const result = await healOn(newSite, scripted([selectorAnswer()]));
      if (result.status !== 'decided') throw new Error('expected a decision');
      const review = renderReview(result.decision, { workflow });
      expect(review).not.toMatch(/shadow|automatic|would have/i);
    });

    it('keeps the verdict in the corpus record', async () => {
      const result = await healOn(newSite, scripted([selectorAnswer()]));
      const record = healRecord({ workflow, knownGood, result, redact: (t) => t });
      expect(record.attempts[0]!.wouldAutoAccept).toEqual({
        policy: SHADOW_AUTO_POLICY,
        eligible: true,
        reasons: [],
      });
    });
  });
});

describe('resolveHealLimits', () => {
  it('fills in defaults', () => {
    expect(resolveHealLimits()).toEqual(DEFAULT_HEAL_LIMITS);
    expect(resolveHealLimits({ maxAttemptsPerFailure: 5 }).maxAttemptsPerFailure).toBe(5);
  });

  it('refuses a limit that is not a positive whole number', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveHealLimits({ maxTokensPerHeal: bad })).toThrow(RangeError);
    }
  });

  it('rejects heal() with invalid limits before doing anything', async () => {
    const provider = scripted([selectorAnswer()]);
    await expect(
      healOn(newSite, provider, { limits: { maxAttemptsPerFailure: 0 } }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(provider.calls).toHaveLength(0);
  });
});

describe('shadowDecision', () => {
  it('reports a patch the checks would refuse as rejected, not eligible', () => {
    const patch = {
      workflowId: workflow.id,
      baseHash: 'sha256:not-this-workflow',
      stepId: 'click_002',
      op: 'replace',
      before: click002,
      after: click002,
      rationale: 'x',
    } as unknown as StepPatch;
    const shadow = shadowDecision({
      workflow,
      patchClass: 'selector',
      score: { score: 0.9, level: 'high', signals: [] },
      verification: { status: 'not_applied', patch, errors: [] },
    });
    expect(shadow).toEqual({ policy: SHADOW_AUTO_POLICY, eligible: false, reasons: ['rejected'] });
  });
});

describe('heal: a site change that broke two steps', () => {
  // The redesign renames both links. The first heal can only progress; it
  // is held for a person, and the second heal, from the patched workflow,
  // verifies in full.
  const details = {
    id: 'click_004',
    intent: 'Open the order details.',
    action: 'click',
    target: { candidates: [{ kind: 'role', value: "link[name='Details']" }] },
  };
  const twoLinks = {
    ...workflow,
    id: 'wf_two_links',
    steps: [...(workflow.steps as unknown as Loose[]).slice(0, 2), details, workflow.steps[2]],
  } as unknown as Workflow;
  const redesigned: Site = { links: ['My orders', 'Order details'], heading: 'Order 1042' };

  async function failedRun(wf: Workflow): Promise<ReplayOutcome> {
    const report = await replay(wf, {
      pageFactory: () => sitePage(redesigned),
      runner: interpretWorkflow,
      runs: 1,
    });
    return report.replays[0]!;
  }

  it('decides the first heal as a partial heal, then fully verifies the second', async () => {
    const history = new MemoryHealHistory();
    const base = {
      knownGood,
      redact: (text: string) => text,
      pageFactory: () => sitePage(redesigned),
      history,
    };

    const first = await heal({
      ...base,
      workflow: twoLinks,
      outcome: await failedRun(twoLinks),
      provider: scripted([selectorAnswer()]),
    });
    expect(first.status).toBe('decided');
    if (first.status !== 'decided') return;
    expect(first.attempts[0]!.verification).toMatchObject({
      status: 'progressed',
      failedStepId: 'click_004',
      outputsMatched: 0,
    });
    expect(first.decision.status).toBe('awaiting_approval');
    if (first.decision.status !== 'awaiting_approval') return;
    expect(first.decision.reasons.map((r) => r.code)).toContain('partial_heal');
    // The reviewer is told the truth about the runs: none reached the end.
    const review = renderReview(first.decision, { workflow: twoLinks });
    expect(review).toContain('none of the 3 live runs reached the end');
    expect(review).not.toContain('0 of 3 live runs passed');

    const patched = first.decision.workflow;
    const second = await heal({
      ...base,
      workflow: patched,
      outcome: await failedRun(patched),
      provider: scripted([
        JSON.stringify({
          after: {
            ...details,
            target: { candidates: [{ kind: 'role', value: "link[name='Order details']" }] },
          },
          rationale: 'The link was renamed.',
          confidence: 0.9,
        }),
      ]),
    });
    expect(second.status).toBe('decided');
    if (second.status !== 'decided') return;
    expect(second.attempts[0]!.verification?.status).toBe('verified');
    expect(
      second.decision.status === 'awaiting_approval' &&
        second.decision.reasons.some((r) => r.code === 'partial_heal'),
    ).toBe(false);
  });
});
