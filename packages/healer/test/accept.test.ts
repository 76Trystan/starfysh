import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashWorkflow } from '@sfysh/ir';
import type { Step, StepPatch, Workflow } from '@sfysh/ir';
import type { Locator, Page } from '@sfysh/runtime';
import { replay } from '@sfysh/verifier';
import type { RunnerFn } from '@sfysh/verifier';
import {
  approvePatch,
  CONFIDENCE_HIGH,
  decidePatch,
  DEFAULT_ACCEPTANCE_POLICY,
  MIN_ACCEPT_RUNS,
  verifyPatch,
} from '../src/index.js';
import type {
  AcceptancePolicy,
  PatchDecision,
  PatchScore,
  PatchVerification,
  VerifyPatchInput,
} from '../src/index.js';

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
  /** Accessible names of links that exist. Clicking any other link throws. */
  links: string[];
  /** Text of the `h1`. */
  heading: string;
  /** Whether `#banner` is visible. */
  banner?: boolean;
}

/** A fake page for one version of the site. */
function sitePage(site: Site): Page {
  const locator = (exists: boolean, texts: string[] = [], visible = true): Locator =>
    ({
      click: async () => {
        if (!exists) throw new Error('locator.click: Timeout 30000ms exceeded.');
      },
      fill: async () => {},
      isVisible: async () => exists && visible,
      count: async () => (exists ? 1 : 0),
      allTextContents: async () => texts,
      all: async () => [],
      locator: () => locator(false),
      nth: () => locator(exists, texts, visible),
    }) as unknown as Locator;
  return {
    goto: async () => {},
    url: () => 'https://portal.example.com/',
    waitForTimeout: async () => {},
    locator: (selector: string) => {
      if (selector === 'h1') return locator(true, [site.heading]);
      if (selector === '#banner') return locator(true, [], site.banner ?? false);
      return locator(false);
    },
    getByRole: (_role: string, options?: { name?: string }) =>
      locator(site.links.includes(options?.name ?? '')),
    getByTestId: () => locator(false),
    getByText: () => locator(false),
    getByLabel: () => locator(false),
  } as unknown as Page;
}

const oldSite: Site = { links: ['Orders'], heading: 'Order 1042' };
/** The site after a redesign renamed the link. */
const newSite: Site = { links: ['My orders'], heading: 'Order 1042' };

const stepOf = (wf: Workflow, id: string) =>
  (wf.steps as unknown as Loose[]).find((s) => s.id === id)! as unknown as Step;

function selectorPatch(name = 'My orders', wf: Workflow = workflow): StepPatch {
  const before = stepOf(wf, 'click_002');
  return {
    workflowId: wf.id,
    baseHash: hashWorkflow(wf),
    stepId: 'click_002',
    op: 'replace',
    before,
    after: {
      ...before,
      target: { candidates: [{ kind: 'role', value: `link[name='${name}']` }] },
    } as unknown as Step,
    rationale: 'The link was renamed.',
    confidence: 0.9,
  };
}

function insertPatch(): StepPatch {
  return {
    workflowId: workflow.id,
    baseHash: hashWorkflow(workflow),
    stepId: 'click_002',
    op: 'insert_before',
    after: {
      id: 'healed_001',
      intent: 'Dismiss the cookie banner.',
      action: 'click',
      target: { candidates: [{ kind: 'role', value: "link[name='Accept']" }] },
    } as unknown as Step,
    rationale: 'A banner now covers the link.',
    confidence: 0.5,
  };
}

const highScore: PatchScore = { score: 0.9, level: 'high', signals: [] };
const lowScore: PatchScore = { score: 0.55, level: 'medium', signals: [] };

let knownGoodOutputs: unknown[];

beforeEach(async () => {
  // The known-good outputs are what the original workflow produced on the
  // site before it changed, collected the way a scheduler would.
  const report = await replay(workflow, {
    pageFactory: () => sitePage(oldSite),
    runner: (await import('@sfysh/verifier')).interpretWorkflow,
    runs: 1,
  });
  expect(report.passed).toBe(1);
  knownGoodOutputs = report.replays[0]!.outputs;
  expect(knownGoodOutputs).toEqual([{ extract_003: 'Order 1042' }]);
});

function verifyInput(overrides: Partial<VerifyPatchInput> = {}): VerifyPatchInput {
  return {
    workflow,
    patch: selectorPatch(),
    knownGood: { outputs: knownGoodOutputs },
    pageFactory: () => sitePage(newSite),
    ...overrides,
  };
}

async function verified(overrides: Partial<VerifyPatchInput> = {}) {
  const result = await verifyPatch(verifyInput(overrides));
  if (result.status !== 'verified') {
    throw new Error(`expected verified, got ${JSON.stringify(result)}`);
  }
  return result;
}

describe('verifyPatch', () => {
  it('verifies a patch that fixes the run and keeps the known-good outputs', async () => {
    const result = await verified();
    expect(result.report.runs).toBe(MIN_ACCEPT_RUNS);
    expect(result.report.passed).toBe(MIN_ACCEPT_RUNS);
    expect(result.stepRan).toBe('confirmed');
    expect(result.hash).toBe(hashWorkflow(result.workflow));
    expect(stepOf(result.workflow, 'click_002')).toEqual(selectorPatch().after);
  });

  it('does not change the workflow it was given', async () => {
    const copy = structuredClone(workflow);
    await verified();
    expect(workflow).toEqual(copy);
  });

  it('runs a fresh page for every run', async () => {
    let pages = 0;
    await verified({
      runs: 5,
      pageFactory: () => {
        pages++;
        return sitePage(newSite);
      },
    });
    expect(pages).toBe(5);
  });

  it('refuses fewer than the minimum number of runs', async () => {
    await expect(verifyPatch(verifyInput({ runs: 2 }))).rejects.toBeInstanceOf(RangeError);
    await expect(verifyPatch(verifyInput({ runs: 3.5 }))).rejects.toBeInstanceOf(RangeError);
    expect(MIN_ACCEPT_RUNS).toBe(3);
  });

  it('reports a patch that does not apply and runs nothing', async () => {
    let pages = 0;
    const stale = { ...selectorPatch(), baseHash: 'sha256:0000' };
    const result = await verifyPatch(
      verifyInput({
        patch: stale,
        pageFactory: () => {
          pages++;
          return sitePage(newSite);
        },
      }),
    );
    expect(result.status).toBe('not_applied');
    expect(pages).toBe(0);
  });

  it('fails a patch whose runs fail, naming each run', async () => {
    const result = await verifyPatch(verifyInput({ patch: selectorPatch('Purchases') }));
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failures.map((f) => [f.code, f.run])).toEqual([
      ['run_failed', 0],
      ['run_failed', 1],
      ['run_failed', 2],
    ]);
  });

  it('fails a patch that passes every run but reads something other than the known-good output', async () => {
    // The false heal the gate exists for: the runs agree with each other,
    // and they are all wrong.
    const result = await verifyPatch(
      verifyInput({ pageFactory: () => sitePage({ ...newSite, heading: 'Order 7' }) }),
    );
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.report.stability.stable).toBe(true);
    expect(result.failures.map((f) => f.code)).toEqual([
      'output_mismatch',
      'output_mismatch',
      'output_mismatch',
    ]);
    expect(result.failures[0]!.drift).toEqual([
      { path: '0.extract_003', values: ['Order 1042', 'Order 7'] },
    ]);
  });

  it('fails a patch whose runs disagree with each other', async () => {
    const headings = ['Order 1042', 'Order 1042', 'Order 1043'];
    let n = 0;
    const result = await verifyPatch(
      verifyInput({ pageFactory: () => sitePage({ ...newSite, heading: headings[n++]! }) }),
    );
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failures.map((f) => [f.code, f.run])).toEqual([
      ['unstable', undefined],
      ['output_mismatch', 2],
    ]);
  });

  it('applies the tolerance map to the known-good comparison', async () => {
    const result = await verifyPatch(
      verifyInput({
        pageFactory: () => sitePage({ ...newSite, heading: 'Order 7' }),
        tolerance: { '0.extract_003': 'ignore' },
      }),
    );
    expect(result.status).toBe('verified');
  });

  it('fails when the known-good run produced an output the patched runs do not', async () => {
    const result = await verifyPatch(
      verifyInput({ knownGood: { outputs: [...knownGoodOutputs, 'second value'] } }),
    );
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failures.every((f) => f.code === 'output_mismatch')).toBe(true);
  });

  it('fails a patch to a step that never ran, even though every run passed', async () => {
    const guarded = {
      ...workflow,
      steps: [
        workflow.steps[0],
        {
          id: 'guard_002',
          intent: 'Dismiss the banner if there is one.',
          action: 'guard',
          if: { selectorVisible: '#banner' },
          then: [
            {
              id: 'click_banner',
              intent: 'Dismiss the banner.',
              action: 'click',
              target: { candidates: [{ kind: 'role', value: "link[name='Close']" }] },
            },
          ],
        },
        workflow.steps[1],
        workflow.steps[2],
      ],
    } as unknown as Workflow;
    const before = stepOf(
      { steps: (guarded.steps[1] as unknown as { then: Step[] }).then } as unknown as Workflow,
      'click_banner',
    );
    const patch: StepPatch = {
      workflowId: guarded.id,
      baseHash: hashWorkflow(guarded),
      stepId: 'click_banner',
      op: 'replace',
      before,
      after: {
        ...before,
        target: { candidates: [{ kind: 'role', value: "link[name='Dismiss']" }] },
      } as unknown as Step,
      rationale: 'Renamed.',
    };
    const result = await verifyPatch(
      verifyInput({
        workflow: guarded,
        patch,
        pageFactory: () => sitePage({ ...oldSite, banner: false }),
      }),
    );
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.report.passed).toBe(3);
    expect(result.failures.map((f) => f.code)).toEqual([
      'patched_step_not_run',
      'patched_step_not_run',
      'patched_step_not_run',
    ]);
  });

  it('watches the inserted step, not the anchor, for an insert-step patch', async () => {
    const result = await verified({
      patch: insertPatch(),
      pageFactory: () => sitePage({ ...oldSite, links: ['Orders', 'Accept'] }),
    });
    expect(result.stepRan).toBe('confirmed');
    expect(result.workflow.steps.map((s) => s.id)).toEqual([
      'nav_001',
      'healed_001',
      'click_002',
      'extract_003',
    ]);
  });

  it('marks the step check unchecked when a custom runner is used', async () => {
    const runner: RunnerFn = async (ctx) => {
      ctx.emit.output({ extract_003: 'Order 1042' });
    };
    const result = await verified({ runner });
    expect(result.stepRan).toBe('unchecked');
  });

  it('passes params to the interpreter', async () => {
    const parameterised = {
      ...workflow,
      parameters: { startUrl: { type: 'string' } },
      steps: [
        { ...(workflow.steps[0] as unknown as Loose), url: { param: 'startUrl' } },
        workflow.steps[1],
        workflow.steps[2],
      ],
    } as unknown as Workflow;
    const without = await verifyPatch(
      verifyInput({ workflow: parameterised, patch: selectorPatch('My orders', parameterised) }),
    );
    expect(without.status).toBe('failed');
    const withParams = await verifyPatch(
      verifyInput({
        workflow: parameterised,
        patch: selectorPatch('My orders', parameterised),
        params: { startUrl: 'https://portal.example.com/' },
      }),
    );
    expect(withParams.status).toBe('verified');
  });

  describe('default vault resolver', () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
    });

    const withSecret = {
      ...workflow,
      secrets: ['portal_pass'],
      steps: [
        workflow.steps[0],
        {
          id: 'fill_pass',
          intent: 'Enter the password.',
          action: 'fill',
          target: { candidates: [{ kind: 'role', value: "textbox[name='Password']" }] },
          value: { secret: 'portal_pass' },
        },
        workflow.steps[1],
        workflow.steps[2],
      ],
    } as unknown as Workflow;
    const site = { ...newSite, links: [...newSite.links] };
    const page = () => {
      const p = sitePage(site);
      return { ...p, getByRole: () => p.locator('h1') } as unknown as Page;
    };

    it('reads the prefixed variable', async () => {
      delete process.env['PORTAL_PASS'];
      process.env['SFYSH_SECRET_PORTAL_PASS'] = 'pw-from-prefixed';
      const result = await verifyPatch(
        verifyInput({
          workflow: withSecret,
          patch: selectorPatch('My orders', withSecret),
          pageFactory: page,
        }),
      );
      expect(result.status).toBe('verified');
    });

    it('never falls back to the unprefixed variable', async () => {
      delete process.env['SFYSH_SECRET_PORTAL_PASS'];
      process.env['PORTAL_PASS'] = 'pw-from-legacy';
      const result = await verifyPatch(
        verifyInput({
          workflow: withSecret,
          patch: selectorPatch('My orders', withSecret),
          pageFactory: page,
        }),
      );
      expect(result.status).toBe('failed');
      if (result.status !== 'failed') return;
      expect(result.report.replays[0]!.error?.name).toBe('VaultSecretMissingError');
    });
  });
});

async function decision(
  policy?: AcceptancePolicy,
  overrides: { score?: PatchScore; verification?: PatchVerification } = {},
): Promise<PatchDecision> {
  return decidePatch({
    workflow,
    patchClass: 'selector',
    score: overrides.score ?? highScore,
    verification: overrides.verification ?? (await verified()),
    ...(policy !== undefined ? { policy } : {}),
  });
}

describe('decidePatch', () => {
  it('sends every verified patch to a person by default', async () => {
    expect(DEFAULT_ACCEPTANCE_POLICY).toEqual({ mode: 'human' });
    const result = await decision();
    expect(result.status).toBe('awaiting_approval');
    if (result.status !== 'awaiting_approval') return;
    expect(result.reasons.map((r) => r.code)).toEqual(['policy_requires_review']);
    expect(result.workflow).toEqual((await verified()).workflow);
  });

  it('accepts under the auto policy only a verified selector patch at or above the threshold', async () => {
    const result = await decision({ mode: 'auto', minScore: 0.85 });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.acceptedBy).toEqual({ kind: 'policy' });
  });

  it('holds a patch scoring below the auto threshold', async () => {
    const result = await decision({ mode: 'auto', minScore: 0.85 }, { score: lowScore });
    expect(result.status).toBe('awaiting_approval');
    if (result.status !== 'awaiting_approval') return;
    expect(result.reasons.map((r) => r.code)).toEqual(['score_below_threshold']);
  });

  it('refuses an auto threshold below high confidence, or above 1', async () => {
    const verification = await verified();
    for (const minScore of [CONFIDENCE_HIGH - 0.01, 0, 1.01, Number.NaN]) {
      expect(() =>
        decidePatch({
          workflow,
          patchClass: 'selector',
          score: highScore,
          verification,
          policy: { mode: 'auto', minScore },
        }),
      ).toThrow(RangeError);
    }
  });

  it('always holds an insert-step patch, whatever the policy and score', async () => {
    const verification = await verified({
      patch: insertPatch(),
      pageFactory: () => sitePage({ ...oldSite, links: ['Orders', 'Accept'] }),
    });
    const result = decidePatch({
      workflow,
      patchClass: 'insert_step',
      score: { score: 1, level: 'high', signals: [] },
      verification,
      policy: { mode: 'auto', minScore: CONFIDENCE_HIGH },
    });
    expect(result.status).toBe('awaiting_approval');
    if (result.status !== 'awaiting_approval') return;
    expect(result.reasons.map((r) => r.code)).toEqual(['insert_step']);
  });

  it('holds a patch whose step was not confirmed to run', async () => {
    const runner: RunnerFn = async (ctx) => ctx.emit.output({ extract_003: 'Order 1042' });
    const result = await decision(
      { mode: 'auto', minScore: CONFIDENCE_HIGH },
      { verification: await verified({ runner }) },
    );
    expect(result.status).toBe('awaiting_approval');
    if (result.status !== 'awaiting_approval') return;
    expect(result.reasons.map((r) => r.code)).toEqual(['step_not_confirmed']);
  });

  it('holds a patch the checks asked a person to confirm, and lists the points', async () => {
    const withSecret = {
      ...workflow,
      secrets: ['portal_pass'],
      steps: [
        workflow.steps[0],
        {
          id: 'fill_pass',
          intent: 'Enter the password.',
          action: 'fill',
          target: { candidates: [{ kind: 'role', value: "textbox[name='Password']" }] },
          value: { secret: 'portal_pass' },
        },
        workflow.steps[2],
      ],
    } as unknown as Workflow;
    const before = stepOf(withSecret, 'fill_pass');
    const patch: StepPatch = {
      workflowId: withSecret.id,
      baseHash: hashWorkflow(withSecret),
      stepId: 'fill_pass',
      op: 'replace',
      before,
      after: {
        ...before,
        target: { candidates: [{ kind: 'role', value: "textbox[name='Passphrase']" }] },
      } as unknown as Step,
      rationale: 'Renamed.',
    };
    const verification = await verified({
      workflow: withSecret,
      patch,
      runner: async (ctx) => ctx.emit.output({ extract_003: 'Order 1042' }),
    });
    const result = decidePatch({
      workflow: withSecret,
      patchClass: 'selector',
      score: highScore,
      verification,
    });
    expect(result.status).toBe('awaiting_approval');
    if (result.status !== 'awaiting_approval') return;
    expect(result.reasons.map((r) => r.code)).toEqual([
      'policy_requires_review',
      'checks_require_review',
      'step_not_confirmed',
    ]);
    expect(result.approvals.map((a) => a.code)).toEqual(['secret_retargeted']);
  });

  it('rejects a patch that failed verification', async () => {
    const verification = await verifyPatch(verifyInput({ patch: selectorPatch('Purchases') }));
    const result = await decision({ mode: 'auto', minScore: CONFIDENCE_HIGH }, { verification });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.message).toContain('run_failed');
  });

  it('re-runs the patch checks instead of trusting the caller', async () => {
    // A verified patch that also points the step somewhere it may not go:
    // the class check refuses a change to anything but the candidates.
    const before = stepOf(workflow, 'click_002');
    const sneaky: StepPatch = {
      ...selectorPatch(),
      after: {
        ...before,
        target: { candidates: [{ kind: 'role', value: "link[name='My orders']" }] },
        timeoutMs: 1,
      } as unknown as Step,
    };
    const verification = await verified({ patch: sneaky });
    const result = await decision({ mode: 'auto', minScore: CONFIDENCE_HIGH }, { verification });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.violations?.map((v) => v.code)).toContain('field_not_allowed');
  });
});

describe('approvePatch', () => {
  it('accepts a patch awaiting approval and records who and when', async () => {
    const pending = await decision();
    const at = new Date('2026-11-17T09:30:00Z');
    const result = approvePatch({ decision: pending, current: workflow, reviewer: ' alex ', at });
    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') return;
    expect(result.decision.acceptedBy).toEqual({
      kind: 'reviewer',
      reviewer: 'alex',
      at: '2026-11-17T09:30:00.000Z',
    });
    expect(result.decision.hash).toBe(hashWorkflow(result.decision.workflow));
  });

  it('refuses a decision that is not awaiting approval', async () => {
    const accepted = await decision({ mode: 'auto', minScore: CONFIDENCE_HIGH });
    const result = approvePatch({ decision: accepted, current: workflow, reviewer: 'alex' });
    expect(result).toMatchObject({ status: 'refused', code: 'not_awaiting_approval' });
  });

  it('refuses an approval with no reviewer', async () => {
    const result = approvePatch({ decision: await decision(), current: workflow, reviewer: '  ' });
    expect(result).toMatchObject({ status: 'refused', code: 'no_reviewer' });
  });

  it('refuses a patch whose workflow changed while it waited', async () => {
    const changed = { ...workflow, name: 'Read the latest order (edited)' } as Workflow;
    const result = approvePatch({ decision: await decision(), current: changed, reviewer: 'alex' });
    expect(result).toMatchObject({ status: 'refused', code: 'stale' });
  });

  it('refuses a decision whose patched workflow was altered after verification', async () => {
    const pending = await decision();
    if (pending.status !== 'awaiting_approval') throw new Error('unreachable');
    const tampered: PatchDecision = {
      ...pending,
      workflow: { ...pending.workflow, name: 'Something else' } as Workflow,
    };
    const result = approvePatch({ decision: tampered, current: workflow, reviewer: 'alex' });
    expect(result).toMatchObject({ status: 'refused', code: 'stale' });
  });
});
