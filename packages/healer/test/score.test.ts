import { describe, expect, it } from 'vitest';
import { hashWorkflow, validateWorkflow } from '@sfysh/ir';
import type { Step, StepPatch, Workflow } from '@sfysh/ir';
import type { Provider } from '@sfysh/providers';
import {
  CONFIDENCE_HIGH,
  CONFIDENCE_MEDIUM,
  generateInsertStepPatch,
  generateSelectorPatch,
  INSERT_STEP_MAX_SCORE,
  scorePatch,
} from '../src/index.js';
import type { PatchScore } from '../src/index.js';

const workflow = {
  irVersion: '1.0.0',
  id: 'wf_portal_login',
  name: 'Portal login',
  steps: [
    {
      id: 'click_001',
      intent: 'Submit the login form.',
      action: 'click',
      target: { candidates: [{ kind: 'role', value: "button[name='Sign in']" }] },
      post: [{ urlMatches: '/dashboard' }],
    },
    {
      id: 'click_002',
      intent: 'Open the orders page.',
      action: 'click',
      target: { candidates: [{ kind: 'css', value: 'nav a.orders' }] },
    },
  ],
} as unknown as Workflow;

type Loose = Record<string, unknown>;
type Candidate = { kind: string; value: string };

const SNAPSHOT = [
  '- heading "Welcome back" [level=1]',
  '- textbox "Email"',
  '- textbox "Password"',
  '- button "Log in"',
  '- link "Forgot password?"',
  '- navigation:',
  '  - link "Orders"',
  '  - link "Orders archive"',
  '- button "Say \\"hi\\""',
  '- text: Need help signing in',
  '- button "Help"',
  '- button "Help"',
].join('\n');

function replace(
  candidates: Candidate[],
  extra: Partial<StepPatch> = {},
  id = 'click_001',
): StepPatch {
  const before = (workflow.steps as unknown as Loose[]).find((s) => s.id === id)!;
  return {
    workflowId: workflow.id,
    baseHash: hashWorkflow(workflow),
    stepId: id,
    op: 'replace',
    before: before as unknown as Step,
    after: { ...before, target: { candidates } } as unknown as Step,
    rationale: 'test',
    ...extra,
  };
}

function insert(after: Loose, extra: Partial<StepPatch> = {}): StepPatch {
  return {
    workflowId: workflow.id,
    baseHash: hashWorkflow(workflow),
    stepId: 'click_001',
    op: 'insert_before',
    after: { id: 'healed_001', ...after } as unknown as Step,
    rationale: 'test',
    ...extra,
  };
}

const click = (candidates: Candidate[]) => ({
  intent: 'Dismiss the dialog.',
  action: 'click',
  target: { candidates },
});

function score(patch: StepPatch, truncated = false, text = SNAPSHOT): PatchScore {
  return scorePatch({
    patch,
    workflow,
    snapshot: { text, truncated },
    patchClass: patch.op === 'replace' ? 'selector' : 'insert_step',
  });
}

const codes = (result: PatchScore) => result.signals.map((s) => s.code);
const effectOf = (result: PatchScore, code: string) =>
  result.signals.find((s) => s.code === code)?.effect;

describe('scorePatch(): selector patches', () => {
  it('uses a workflow that passes IR validation', () => {
    expect(validateWorkflow(workflow).valid).toBe(true);
  });

  it('scores a unique role selector with a fallback as high', () => {
    const result = score(
      replace([
        { kind: 'role', value: "button[name='Log in']" },
        { kind: 'css', value: 'form button' },
      ]),
    );
    expect(result).toMatchObject({ score: 0.95, level: 'high' });
    expect(codes(result)).toEqual([
      'base',
      'first_candidate_unique',
      'first_candidate_kind',
      'same_role',
    ]);
    expect(result.modelConfidence).toBeUndefined();
  });

  it('reaches 1 when a fallback is grounded too', () => {
    const result = score(
      replace([
        { kind: 'role', value: "button[name='Log in']" },
        { kind: 'text', value: 'Log in' },
      ]),
    );
    expect(result.score).toBe(1);
    expect(codes(result)).toContain('fallback_grounded');
  });

  it('scores a selector that names nothing in the snapshot as low', () => {
    const result = score(replace([{ kind: 'role', value: "button[name='Continue']" }]));
    expect(result).toMatchObject({ score: 0.35, level: 'low' });
    expect(effectOf(result, 'first_candidate_not_found')).toBe(-0.3);
  });

  it('scores an ambiguous selector as medium', () => {
    const result = score(replace([{ kind: 'role', value: "button[name='Help']" }]));
    expect(result).toMatchObject({ score: 0.7, level: 'medium' });
    expect(codes(result)).toContain('first_candidate_ambiguous');
  });

  it('treats a role with no name as matching every element of that role', () => {
    expect(codes(score(replace([{ kind: 'role', value: 'heading' }])))).toContain(
      'first_candidate_unique',
    );
    expect(codes(score(replace([{ kind: 'role', value: 'button' }])))).toContain(
      'first_candidate_ambiguous',
    );
  });

  it('matches a name as a case-insensitive substring', () => {
    const result = score(replace([{ kind: 'role', value: "link[name='forgot']" }]));
    expect(codes(result)).toContain('first_candidate_unique');
    // "Orders" is a substring of both "Orders" and "Orders archive".
    expect(codes(score(replace([{ kind: 'role', value: "link[name='Orders']" }])))).toContain(
      'first_candidate_ambiguous',
    );
  });

  it('matches the whole name when the selector says exact=true', () => {
    // Without exact=true, "Orders" also names "Orders archive".
    const exact = score(replace([{ kind: 'role', value: "link[name='Orders'][exact=true]" }]));
    expect(codes(exact)).toContain('first_candidate_unique');
    expect(codes(exact)).not.toContain('first_candidate_ambiguous');
    // A partial name with exact=true names nothing.
    expect(
      codes(score(replace([{ kind: 'role', value: "link[name='Order'][exact=true]" }]))),
    ).toContain('first_candidate_not_found');
    // Two elements with the very same name stay ambiguous.
    expect(
      codes(score(replace([{ kind: 'role', value: "button[name='Help'][exact=true]" }]))),
    ).toContain('first_candidate_ambiguous');
  });

  it('reads nested lines and escaped quotes in the snapshot', () => {
    expect(
      codes(score(replace([{ kind: 'role', value: "link[name='Orders archive']" }]))),
    ).toContain('first_candidate_unique');
    expect(codes(score(replace([{ kind: 'role', value: `button[name='Say "hi"']` }])))).toContain(
      'first_candidate_unique',
    );
  });

  it('cannot confirm a css selector or a test id, and marks css down', () => {
    const css = score(replace([{ kind: 'css', value: 'form button' }]));
    expect(codes(css)).toContain('first_candidate_unverifiable');
    expect(css).toMatchObject({ score: 0.4, level: 'low' });

    const testid = score(replace([{ kind: 'testid', value: 'login-submit' }]));
    expect(testid).toMatchObject({ score: 0.55, level: 'medium' });
  });

  it('grounds text and label candidates in the snapshot text', () => {
    const found = score(replace([{ kind: 'text', value: 'need help signing in' }]));
    expect(codes(found)).toContain('first_candidate_unique');
    const missing = score(replace([{ kind: 'label', value: 'Phone number' }]));
    expect(codes(missing)).toContain('first_candidate_not_found');
  });

  it('marks down a fallback the model made up', () => {
    const result = score(
      replace([
        { kind: 'role', value: "button[name='Log in']" },
        { kind: 'role', value: "button[name='Enter']" },
      ]),
    );
    expect(effectOf(result, 'fallback_not_found')).toBe(-0.1);
    expect(result.score).toBe(0.85);
  });

  it('gives the same-role bonus only when the role is unchanged', () => {
    const changed = score(replace([{ kind: 'role', value: "link[name='Forgot password?']" }]));
    expect(codes(changed)).not.toContain('same_role');
    // The old first candidate of click_002 is css, so there is no role to compare.
    const fromCss = score(
      replace([{ kind: 'role', value: "link[name='Orders archive']" }], {}, 'click_002'),
    );
    expect(codes(fromCss)).not.toContain('same_role');
  });

  it('marks down a truncated snapshot, but not twice when a selector was not found', () => {
    const grounded = score(replace([{ kind: 'role', value: "button[name='Log in']" }]), true);
    expect(effectOf(grounded, 'snapshot_truncated')).toBe(-0.1);
    expect(grounded.score).toBe(0.85);

    const missing = score(replace([{ kind: 'role', value: "button[name='Continue']" }]), true);
    expect(effectOf(missing, 'snapshot_truncated')).toBe(0);
    expect(missing.score).toBe(0.35);
  });
});

describe('scorePatch(): the confidence the model reported', () => {
  const strong = [{ kind: 'role', value: "button[name='Log in']" }];

  it('can lower the score', () => {
    const result = score(replace(strong, { confidence: 0.4 }));
    expect(result).toMatchObject({ score: 0.4, level: 'low', modelConfidence: 0.4 });
    expect(effectOf(result, 'model_less_confident')).toBe(-0.55);
  });

  it('can never raise it', () => {
    const weak = [{ kind: 'role', value: "button[name='Continue']" }];
    const result = score(replace(weak, { confidence: 1 }));
    expect(result).toMatchObject({ score: 0.35, level: 'low', modelConfidence: 1 });
    expect(codes(result)).not.toContain('model_less_confident');
  });

  it('takes a reported zero at its word', () => {
    expect(score(replace(strong, { confidence: 0 }))).toMatchObject({ score: 0, level: 'low' });
  });
});

describe('scorePatch(): insert-step patches', () => {
  it('starts lower and cannot pass the ceiling', () => {
    expect(INSERT_STEP_MAX_SCORE).toBe(0.6);
    const result = score(insert(click([{ kind: 'role', value: "button[name='Log in']" }])));
    expect(result).toMatchObject({ score: 0.6, level: 'medium' });
    expect(effectOf(result, 'insert_step_cap')).toBe(-0.1);
    expect(codes(result)).not.toContain('same_role');
  });

  it('marks down a click that reads like a commitment', () => {
    const snapshot = `${SNAPSHOT}\n- button "Delete account"\n- button "Place order"`;
    for (const candidate of [
      { kind: 'role', value: "button[name='Delete account']" },
      { kind: 'role', value: "button[name='Place order']" },
      { kind: 'text', value: 'Place order' },
      { kind: 'testid', value: 'confirm-purchase' },
      { kind: 'css', value: 'button.pay_now' },
    ]) {
      const result = score(insert(click([candidate])), false, snapshot);
      expect(effectOf(result, 'risky_click')).toBe(-0.4);
      expect(result.level).toBe('low');
    }
  });

  it('checks every candidate of the click, not only the first', () => {
    const result = score(
      insert(
        click([
          { kind: 'role', value: "button[name='Help']" },
          { kind: 'css', value: 'form button.submit' },
        ]),
      ),
    );
    expect(codes(result)).toContain('risky_click');
  });

  it('does not treat an ordinary dismissal as a commitment', () => {
    const snapshot = `${SNAPSHOT}\n- button "Reject all"\n- button "Close"\n- button "Reorder later"`;
    for (const name of ['Reject all', 'Close', 'Reorder later']) {
      const result = score(
        insert(click([{ kind: 'role', value: `button[name='${name}']` }])),
        false,
        snapshot,
      );
      expect(codes(result)).not.toContain('risky_click');
    }
  });

  it('does not apply the commitment rule to a selector patch', () => {
    const snapshot = `${SNAPSHOT}\n- button "Submit"`;
    const result = score(
      replace([{ kind: 'role', value: "button[name='Submit']" }]),
      false,
      snapshot,
    );
    expect(codes(result)).not.toContain('risky_click');
  });

  it('scores a wait, with a small gain when its text is on the page', () => {
    const wait = (forCondition: Loose) => ({ intent: 'Wait.', action: 'wait', forCondition });
    expect(score(insert(wait({ selectorAbsent: 'dialog' })))).toMatchObject({
      score: 0.3,
      level: 'low',
    });
    const withText = score(insert(wait({ textPresent: 'welcome back' })));
    expect(withText.score).toBe(0.4);
    expect(codes(withText)).toEqual(['base', 'wait_text_found']);
    expect(codes(score(insert(wait({ textPresent: 'Loading complete' }))))).toEqual(['base']);
  });
});

describe('scorePatch(): the result', () => {
  it('uses fixed thresholds for the level', () => {
    expect(CONFIDENCE_HIGH).toBe(0.8);
    expect(CONFIDENCE_MEDIUM).toBe(0.5);
    const strong = [{ kind: 'role', value: "button[name='Log in']" }];
    expect(score(replace(strong, { confidence: 0.8 })).level).toBe('high');
    expect(score(replace(strong, { confidence: 0.79 })).level).toBe('medium');
    expect(score(replace(strong, { confidence: 0.5 })).level).toBe('medium');
    expect(score(replace(strong, { confidence: 0.49 })).level).toBe('low');
  });

  it('stays between 0 and 1 and is the clamped sum of its signals', () => {
    const patches = [
      replace([{ kind: 'role', value: "button[name='Log in']" }]),
      replace(
        [
          { kind: 'css', value: 'x' },
          { kind: 'role', value: "button[name='Nope']" },
        ],
        {},
        'click_002',
      ),
      insert(
        click([
          { kind: 'css', value: 'button.delete' },
          { kind: 'text', value: 'Nope' },
        ]),
      ),
      insert(click([{ kind: 'role', value: "button[name='Log in']" }]), { confidence: 0.2 }),
    ];
    for (const patch of patches) {
      const result = score(patch, true);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
      const sum = result.signals.reduce((total, signal) => total + signal.effect, 0);
      expect(result.score).toBeCloseTo(Math.min(1, Math.max(0, sum)), 5);
    }
  });

  it('is deterministic', () => {
    const patch = replace([{ kind: 'role', value: "button[name='Log in']" }]);
    expect(score(patch)).toEqual(score(patch));
  });

  it('does not quote the patch or the page in a signal', () => {
    const snapshot = '- button "SENTINEL-PAGE"';
    const result = score(
      replace([{ kind: 'role', value: "button[name='SENTINEL-PATCH']" }]),
      false,
      snapshot,
    );
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
  });

  it('copes with an empty snapshot and a step with no target', () => {
    expect(score(replace([{ kind: 'role', value: 'button' }]), false, '').level).toBe('low');
    const noTarget = insert({ intent: 'Wait.', action: 'wait', forCondition: { textPresent: '' } });
    expect(score(noTarget).score).toBe(0.3);
  });
});

describe('the generators attach a score', () => {
  const failure = {
    name: 'TimeoutError',
    message: 'Timeout 30000ms exceeded.',
    stepId: 'click_001',
    action: 'click',
  };
  const snapshot = { text: SNAPSHOT, truncated: false, originalLength: SNAPSHOT.length };
  const provider = (content: string): Provider => ({
    name: 'fake',
    complete: async () => ({
      content,
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'fake',
    }),
  });
  const base = { workflow, failure, snapshot, redact: (text: string) => text };
  const healed = (candidates: Candidate[]) => ({
    ...(workflow.steps as unknown as Loose[])[0]!,
    target: { candidates },
  });

  it('replaces the confidence the model reported with the score', async () => {
    const result = await generateSelectorPatch({
      ...base,
      provider: provider(
        JSON.stringify({
          after: healed([{ kind: 'role', value: "button[name='Continue']" }]),
          rationale: 'Renamed.',
          confidence: 0.99,
        }),
      ),
    });
    if (result.status !== 'patch') throw new Error(JSON.stringify(result));
    expect(result.score).toMatchObject({ score: 0.35, level: 'low', modelConfidence: 0.99 });
    expect(result.patch.confidence).toBe(0.35);
  });

  it('scores a patch even when the model gave no confidence', async () => {
    const result = await generateSelectorPatch({
      ...base,
      provider: provider(
        JSON.stringify({
          after: healed([{ kind: 'role', value: "button[name='Log in']" }]),
          rationale: 'Renamed.',
        }),
      ),
    });
    if (result.status !== 'patch') throw new Error(JSON.stringify(result));
    expect(result.score.level).toBe('high');
    expect(result.patch.confidence).toBe(0.95);
  });

  it('scores an insert-step patch under its ceiling', async () => {
    const result = await generateInsertStepPatch({
      ...base,
      provider: provider(
        JSON.stringify({
          step: click([{ kind: 'role', value: "button[name='Log in']" }]),
          rationale: 'Covered.',
          confidence: 1,
        }),
      ),
    });
    if (result.status !== 'patch') throw new Error(JSON.stringify(result));
    expect(result.score.score).toBe(0.6);
    expect(result.patch.confidence).toBe(0.6);
  });
});
