import { describe, expect, it } from 'vitest';
import { applyPatch, hashStep, hashWorkflow } from '@sfysh/ir';
import type { Step, StepPatch, Workflow } from '@sfysh/ir';
import type { Completion, Provider } from '@sfysh/providers';
import type { Locator, Page } from '@sfysh/runtime';
import { interpretWorkflow, replay } from '@sfysh/verifier';
import {
  decidePatch,
  findReversions,
  heal,
  MemoryHealHistory,
  patchRecord,
  verifyPatch,
} from '../src/index.js';
import type { PatchRecord, PatchScore } from '../src/index.js';

type Loose = Record<string, unknown>;

const base = {
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

const at1 = new Date('2026-11-10T08:00:00Z');
const at2 = new Date('2026-11-17T08:00:00Z');

const stepOf = (wf: Workflow, id: string) =>
  (wf.steps as unknown as Loose[]).find((s) => s.id === id)! as unknown as Step;

/** A selector patch to click_002 with the given candidates. */
function relink(wf: Workflow, candidates: unknown[]): StepPatch {
  const before = stepOf(wf, 'click_002');
  return {
    workflowId: wf.id,
    baseHash: hashWorkflow(wf),
    stepId: 'click_002',
    op: 'replace',
    before,
    after: { ...before, target: { candidates } } as unknown as Step,
    rationale: 'Renamed.',
  };
}

const link = (name: string) => ({ kind: 'role', value: `link[name='${name}']` });

function applied(wf: Workflow, patch: StepPatch): Workflow {
  const result = applyPatch(wf, patch);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.workflow;
}

/** The workflow after one heal renamed the link, and the record of that heal. */
function afterFirstHeal(): { healed: Workflow; record: PatchRecord } {
  const first = relink(base, [link('My orders')]);
  const record = patchRecord(base, first, 'accepted', at1)!;
  return { healed: applied(base, first), record };
}

describe('patchRecord', () => {
  it('records where a replace started from and where it went', () => {
    const first = relink(base, [link('My orders')]);
    const record = patchRecord(base, first, 'accepted', at1);
    expect(record).toEqual({
      workflowId: 'wf_orders',
      at: at1,
      stepId: 'click_002',
      op: 'replace',
      fromHash: hashWorkflow(base),
      toHash: hashWorkflow(applied(base, first)),
      stepBefore: hashStep(stepOf(base, 'click_002')),
      firstCandidateBefore: link('Orders'),
      decision: 'accepted',
    });
  });

  it('records no step details for an insert', () => {
    const insert: StepPatch = {
      workflowId: base.id,
      baseHash: hashWorkflow(base),
      stepId: 'click_002',
      op: 'insert_before',
      after: {
        id: 'healed_001',
        intent: 'Dismiss.',
        action: 'click',
        target: { candidates: [link('Accept')] },
      } as unknown as Step,
      rationale: 'Banner.',
    };
    const record = patchRecord(base, insert, 'awaiting_approval', at1)!;
    expect(record.op).toBe('insert_before');
    expect(record).not.toHaveProperty('stepBefore');
    expect(record).not.toHaveProperty('firstCandidateBefore');
  });

  it('returns undefined for a patch that does not apply', () => {
    const stale = { ...relink(base, [link('My orders')]), baseHash: 'nope' };
    expect(patchRecord(base, stale, 'accepted', at1)).toBeUndefined();
  });
});

describe('findReversions', () => {
  it('finds a heal that puts the workflow back exactly as it was', () => {
    const { healed, record } = afterFirstHeal();
    const back = relink(healed, [link('Orders')]);

    expect(findReversions(back, healed, [record]).map((r) => r.code)).toEqual([
      'workflow_revisited',
      'step_reverted',
    ]);
  });

  it('finds a step put back after an unrelated change elsewhere in the workflow', () => {
    const { healed, record } = afterFirstHeal();
    const edited = {
      ...healed,
      steps: healed.steps.map((s) =>
        s.id === 'extract_003' ? ({ ...s, intent: 'Read the order number.' } as Step) : s,
      ),
    } as Workflow;
    const back = relink(edited, [link('Orders')]);

    expect(findReversions(back, edited, [record]).map((r) => r.code)).toEqual(['step_reverted']);
  });

  it('finds a first selector put back even when the rest of the candidates differ', () => {
    const { healed, record } = afterFirstHeal();
    const back = relink(healed, [link('Orders'), { kind: 'css', value: 'nav a.orders' }]);

    const found = findReversions(back, healed, [record]);
    expect(found.map((r) => r.code)).toEqual(['selector_reverted']);
    expect(found[0]!.at).toBe(at1);
    expect(found[0]!.message).toContain('click_002');
  });

  it('finds nothing for a heal that moves forward', () => {
    const { healed, record } = afterFirstHeal();
    expect(findReversions(relink(healed, [link('Purchases')]), healed, [record])).toEqual([]);
  });

  it('does not count a repeat of a heal that was never accepted', () => {
    // A heal proposed "My orders" and a person turned it down, so the
    // workflow is still the original. Proposing it again undoes nothing.
    const first = relink(base, [link('My orders')]);
    const record = patchRecord(base, first, 'awaiting_approval', at1)!;
    expect(findReversions(relink(base, [link('My orders')]), base, [record])).toEqual([]);
  });

  it('ignores records for other workflows', () => {
    const { healed, record } = afterFirstHeal();
    const other = { ...record, workflowId: 'wf_other' };
    expect(findReversions(relink(healed, [link('Orders')]), healed, [other])).toEqual([]);
  });

  it('ignores records for other steps', () => {
    const { healed, record } = afterFirstHeal();
    const other = { ...record, stepId: 'extract_003' };
    expect(
      findReversions(relink(healed, [link('Orders')]), healed, [other]).map((r) => r.code),
    ).toEqual(['workflow_revisited']);
  });

  it('reports each earlier heal that is undone', () => {
    // Orders -> My orders -> Orders -> My orders: the third heal undoes
    // the second, and returns to the first heal's result.
    const { healed, record: r1 } = afterFirstHeal();
    const second = relink(healed, [link('Orders')]);
    const r2 = patchRecord(healed, second, 'accepted', at2)!;
    const back = applied(healed, second);
    const third = relink(back, [link('My orders')]);

    const found = findReversions(third, back, [r1, r2]);
    expect(found.map((r) => [r.code, r.at])).toEqual([
      ['workflow_revisited', at2],
      ['step_reverted', at2],
    ]);
  });

  it('finds an inserted step that recreates a workflow an earlier heal started from', () => {
    const dismiss = {
      id: 'healed_001',
      intent: 'Dismiss the banner.',
      action: 'click',
      target: { candidates: [link('Accept')] },
    } as unknown as Step;
    const insert: StepPatch = {
      workflowId: base.id,
      baseHash: hashWorkflow(base),
      stepId: 'click_002',
      op: 'insert_before',
      after: dismiss,
      rationale: 'Banner.',
    };
    // Some earlier heal started from the workflow with the step in it, and
    // a person later took the step out again.
    const withStep = applied(base, insert);
    const record: PatchRecord = {
      workflowId: base.id,
      at: at1,
      stepId: 'click_002',
      op: 'replace',
      fromHash: hashWorkflow(withStep),
      toHash: 'sha256:elsewhere',
      decision: 'accepted',
    };
    expect(findReversions(insert, base, [record]).map((r) => r.code)).toEqual([
      'workflow_revisited',
    ]);
  });

  it('returns nothing for a patch that does not apply', () => {
    const { healed, record } = afterFirstHeal();
    const stale = { ...relink(healed, [link('Orders')]), baseHash: 'nope' };
    expect(findReversions(stale, healed, [record])).toEqual([]);
  });
});

// A fake site, for the decision and end-to-end checks.
interface Site {
  links: string[];
}

function sitePage(site: Site): Page {
  const locator = (exists: boolean, texts: string[] = []): Locator =>
    ({
      click: async () => {
        if (!exists) {
          const error = new Error('locator.click: Timeout 30000ms exceeded.');
          error.name = 'TimeoutError';
          throw error;
        }
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
    locator: (selector: string) => locator(selector === 'h1', ['Order 1042']),
    getByRole: (_role: string, options?: { name?: string }) =>
      locator(site.links.includes(options?.name ?? '')),
    getByTestId: () => locator(false),
    getByText: () => locator(false),
    getByLabel: () => locator(false),
    snapshot: async () =>
      [...site.links.map((l) => `- link "${l}"`), '- heading "Order 1042" [level=1]'].join('\n'),
  } as unknown as Page;
}

const knownGood = { outputs: [{ extract_003: 'Order 1042' }] };
const highScore: PatchScore = { score: 0.95, level: 'high', signals: [] };

describe('decidePatch with reversions', () => {
  it('holds a reverting patch for a person even under the auto policy', async () => {
    const { healed, record } = afterFirstHeal();
    const back = relink(healed, [link('Orders')]);
    const verification = await verifyPatch({
      workflow: healed,
      patch: back,
      knownGood,
      pageFactory: () => sitePage({ links: ['Orders'] }),
    });
    const decision = decidePatch({
      workflow: healed,
      patchClass: 'selector',
      score: highScore,
      verification,
      policy: { mode: 'auto', minScore: 0.8 },
      reversions: findReversions(back, healed, [record]),
    });

    expect(decision.status).toBe('awaiting_approval');
    if (decision.status !== 'awaiting_approval') return;
    expect(decision.reasons.map((r) => r.code)).toEqual(['reverts_earlier_heal']);
    expect(decision.reasons[0]!.message).toContain('switching between versions');
  });

  it('accepts the same patch under the auto policy when it undoes nothing', async () => {
    const { healed } = afterFirstHeal();
    const back = relink(healed, [link('Orders')]);
    const verification = await verifyPatch({
      workflow: healed,
      patch: back,
      knownGood,
      pageFactory: () => sitePage({ links: ['Orders'] }),
    });
    const decision = decidePatch({
      workflow: healed,
      patchClass: 'selector',
      score: highScore,
      verification,
      policy: { mode: 'auto', minScore: 0.8 },
      reversions: [],
    });
    expect(decision.status).toBe('accepted');
  });
});

describe('heal on a site that flips back', () => {
  const answer = (name: string) =>
    JSON.stringify({
      after: { ...stepOf(base, 'click_002'), target: { candidates: [link(name)] } },
      rationale: 'The link was renamed.',
      confidence: 0.95,
    });

  function provider(name: string): Provider {
    return {
      name: 'fake',
      model: 'fake-model',
      complete: async () =>
        ({
          content: answer(name),
          stopReason: 'end',
          usage: { inputTokens: 100, outputTokens: 10 },
          model: 'fake-model',
        }) satisfies Completion,
    };
  }

  async function failedOn(wf: Workflow, site: Site) {
    const report = await replay(wf, {
      pageFactory: () => sitePage(site),
      runner: interpretWorkflow,
      runs: 1,
    });
    return report.replays[0]!;
  }

  it('auto-accepts the first heal, then holds the heal that switches back', async () => {
    const history = new MemoryHealHistory();
    const redesign: Site = { links: ['My orders'] };
    const rollback: Site = { links: ['Orders'] };
    const common = {
      knownGood,
      redact: (t: string) => t,
      history,
      policy: { mode: 'auto', minScore: 0.8 } as const,
    };

    const first = await heal({
      ...common,
      workflow: base,
      outcome: await failedOn(base, redesign),
      provider: provider('My orders'),
      pageFactory: () => sitePage(redesign),
      now: () => at1,
    });
    expect(first.status).toBe('decided');
    if (first.status !== 'decided') return;
    expect(first.decision.status).toBe('accepted');
    const healed = first.decision.workflow;

    const second = await heal({
      ...common,
      workflow: healed,
      outcome: await failedOn(healed, rollback),
      provider: provider('Orders'),
      pageFactory: () => sitePage(rollback),
      now: () => at2,
    });
    expect(second.status).toBe('decided');
    if (second.status !== 'decided') return;
    expect(second.decision.status).toBe('awaiting_approval');
    if (second.decision.status !== 'awaiting_approval') return;
    expect(second.decision.reasons.map((r) => r.code)).toEqual(['reverts_earlier_heal']);
    expect(second.attempts[0]!.reversions?.map((r) => r.code)).toEqual([
      'workflow_revisited',
      'step_reverted',
    ]);

    const records = history.patches(base.id);
    expect(records.map((r) => [r.decision, r.at])).toEqual([
      ['accepted', at1],
      ['awaiting_approval', at2],
    ]);
  });

  it('records nothing for a heal that found no patch', async () => {
    const history = new MemoryHealHistory();
    const site: Site = { links: ['My orders'] };
    await heal({
      workflow: base,
      outcome: await failedOn(base, site),
      knownGood,
      provider: provider('Purchases'),
      redact: (t) => t,
      pageFactory: () => sitePage(site),
      history,
    });
    expect(history.patches(base.id)).toEqual([]);
  });
});
