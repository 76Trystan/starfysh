import { describe, expect, it } from 'vitest';
import { hashWorkflow } from '@sfysh/ir';
import type { SelectorCandidate, Step, StepPatch, Workflow } from '@sfysh/ir';
import {
  compareCandidates,
  printable,
  RENDER_VALUE_MAX_CHARS,
  renderReview,
  renderSemanticDiff,
  semanticDiff,
} from '../src/index.js';
import type { PatchDecision, PatchScore } from '../src/index.js';

// Built from codes so this file holds no raw control or separator characters.
const ESC = String.fromCharCode(27);
const LS = String.fromCharCode(0x2028);
const NEL = String.fromCharCode(0x85);

const role = (value: string): SelectorCandidate => ({ kind: 'role', value });
const css = (value: string): SelectorCandidate => ({ kind: 'css', value });
const testid = (value: string): SelectorCandidate => ({ kind: 'testid', value });

const workflow = {
  irVersion: '1.0.0',
  id: 'wf_orders',
  name: 'Orders',
  steps: [
    {
      id: 'click_002',
      intent: 'Open the orders page.',
      action: 'click',
      target: { candidates: [role("link[name='Orders']"), css('nav a.orders')] },
    },
  ],
} as unknown as Workflow;

const original = workflow.steps[0] as unknown as Step;

function replace(candidates: SelectorCandidate[], extra: Record<string, unknown> = {}): StepPatch {
  return {
    workflowId: workflow.id,
    baseHash: hashWorkflow(workflow),
    stepId: 'click_002',
    op: 'replace',
    before: original,
    after: { ...original, target: { candidates }, ...extra } as unknown as Step,
    rationale: 'The link was renamed.',
  };
}

describe('compareCandidates', () => {
  it('sees an unchanged list', () => {
    const list = [role('a'), css('b')];
    expect(compareCandidates('target', list, [...list]).kind).toBe('unchanged');
  });

  it('sees a promotion as a reorder, and says where the new first came from', () => {
    const change = compareCandidates(
      'target',
      [role('a'), css('b'), testid('c')],
      [css('b'), role('a'), testid('c')],
    );
    expect(change.kind).toBe('reordered');
    expect(change.first).toEqual({ candidate: css('b'), rank: 1, was: 2 });
    expect(change.firstBefore).toEqual(role('a'));
    expect(change.removed).toEqual([]);
  });

  it('sees new candidates put in front of an unchanged list', () => {
    const one = compareCandidates(
      'target',
      [role('a'), css('b')],
      [role('new'), role('a'), css('b')],
    );
    expect(one.kind).toBe('inserted_at_front');
    expect(one.after.map((r) => r.was)).toEqual([undefined, 1, 2]);

    const two = compareCandidates('target', [role('a')], [role('x'), testid('y'), role('a')]);
    expect(two.kind).toBe('inserted_at_front');
  });

  it('calls anything else a change, and lists what was removed', () => {
    const swapped = compareCandidates('target', [role('a'), css('b')], [role('z'), css('b')]);
    expect(swapped.kind).toBe('changed');
    expect(swapped.removed).toEqual([{ candidate: role('a'), was: 1 }]);
    expect(swapped.first).toEqual({ candidate: role('z'), rank: 1 });

    // A fallback added at the end keeps the first choice but is not "at front".
    const appended = compareCandidates('target', [role('a')], [role('a'), css('b')]);
    expect(appended.kind).toBe('changed');
    expect(appended.first.was).toBe(1);

    // New in front, but the old ones were also reordered.
    const mixed = compareCandidates(
      'target',
      [role('a'), css('b')],
      [role('n'), css('b'), role('a')],
    );
    expect(mixed.kind).toBe('changed');
  });

  it('treats the same value under a different kind as a different candidate', () => {
    const change = compareCandidates('target', [role('x')], [css('x')]);
    expect(change.kind).toBe('changed');
  });
});

describe('semanticDiff', () => {
  it('reads a promotion as one candidate change, with no per-index noise', () => {
    const diff = semanticDiff(
      replace([css('nav a.orders'), role("link[name='Orders']")]),
      workflow,
    );
    expect(diff.candidates).toHaveLength(1);
    expect(diff.candidates[0]!.kind).toBe('reordered');
    expect(diff.fields).toEqual([]);
  });

  it('reports other fields one by one, with readable labels', () => {
    const diff = semanticDiff(
      replace([role("link[name='Orders']"), css('nav a.orders')], {
        timeoutMs: 5000,
        post: [{ urlMatches: '/orders' }],
        intent: 'Open the order list.',
      }),
    );
    expect(diff.candidates).toEqual([]);
    expect(diff.fields.map((f) => [f.kind, f.label])).toEqual([
      ['changed', 'intent'],
      ['added', 'post'],
      ['added', 'timeoutMs'],
    ]);
  });

  it('labels nested paths', () => {
    const before = { ...original, post: [{ urlMatches: '/a' }, { urlMatches: '/b' }] };
    const patch: StepPatch = {
      ...replace([]),
      before: before as unknown as Step,
      after: { ...before, post: [{ urlMatches: '/a' }, { urlMatches: '/c' }] } as unknown as Step,
    };
    expect(semanticDiff(patch).fields.map((f) => f.label)).toEqual(['post[1].urlMatches']);
  });

  it('describes an insert by its new step, with the anchor intent from the workflow', () => {
    const insert: StepPatch = {
      workflowId: workflow.id,
      baseHash: hashWorkflow(workflow),
      stepId: 'click_002',
      op: 'insert_before',
      after: {
        id: 'healed_001',
        intent: 'Dismiss the banner.',
        action: 'click',
        target: { candidates: [role("button[name='Accept']")] },
      } as unknown as Step,
      rationale: 'A banner covers the link.',
    };
    const diff = semanticDiff(insert, workflow);
    expect(diff.intent).toBe('Open the orders page.');
    expect(diff.inserted?.id).toBe('healed_001');
    expect(renderSemanticDiff(diff)).toBe(
      [
        'New step healed_001, before step click_002 ("Open the orders page."):',
        '  Action: click',
        '  Intent: "Dismiss the banner."',
        `  Target: role "button[name='Accept']"`,
      ].join('\n'),
    );
  });
});

describe('renderSemanticDiff', () => {
  it('says a promotion is a reorder and names the new first choice', () => {
    const text = renderSemanticDiff(
      semanticDiff(replace([css('nav a.orders'), role("link[name='Orders']")]), workflow),
    );
    expect(text).toBe(
      [
        'Step click_002 ("Open the orders page."):',
        '  Selectors reordered. Now tried first: css "nav a.orders" (was #2).',
        `    Before, the first choice was role "link[name='Orders']".`,
        '    1. css "nav a.orders" (was #2)',
        `    2. role "link[name='Orders']" (was #1)`,
      ].join('\n'),
    );
  });

  it('says a new selector went in front of the old ones', () => {
    const text = renderSemanticDiff(
      semanticDiff(
        replace([role("link[name='My orders']"), role("link[name='Orders']"), css('nav a.orders')]),
        workflow,
      ),
    );
    expect(text).toContain(
      `A new selector is put in front of the existing ones, which keep their order. Now tried first: role "link[name='My orders']".`,
    );
    expect(text).toContain(`1. role "link[name='My orders']" (new)`);
    expect(text).toContain(`2. role "link[name='Orders']" (was #1)`);
  });

  it('lists removed candidates for a general change', () => {
    const text = renderSemanticDiff(
      semanticDiff(replace([role("link[name='My orders']"), css('nav a.orders')]), workflow),
    );
    expect(text).toContain(
      `Selectors changed. Now tried first: role "link[name='My orders']" (new).`,
    );
    expect(text).toContain('2. css "nav a.orders" (same place)');
    expect(text).toContain(`removed: role "link[name='Orders']" (was #1)`);
  });

  it('renders field changes', () => {
    const text = renderSemanticDiff(
      semanticDiff(
        replace([role("link[name='Orders']"), css('nav a.orders')], { timeoutMs: 5000 }),
      ),
    );
    expect(text).toContain('Added timeoutMs: 5000');
  });

  it('says so when a patch changes nothing', () => {
    const text = renderSemanticDiff(
      semanticDiff(replace([role("link[name='Orders']"), css('nav a.orders')])),
    );
    expect(text).toContain('No change.');
  });

  it('keeps hostile selector text on its own line and free of escape sequences', () => {
    const hostile = `x${ESC}[2J${ESC}]0;owned\nApproved: yes${LS}${NEL}`;
    const text = renderSemanticDiff(semanticDiff(replace([css(hostile)]), workflow));
    expect(text.includes(ESC)).toBe(false);
    expect(text.includes(LS)).toBe(false);
    expect(text.includes(NEL)).toBe(false);
    // No line starts with the forged text.
    expect(text.split('\n').some((l) => l.startsWith('Approved'))).toBe(false);
  });
});

describe('printable', () => {
  it('turns runs of control characters into one space', () => {
    expect(printable(`a${ESC}[31m\r\n${LS}b`)).toBe('a [31m b');
  });

  it('cuts long text and says how much was cut', () => {
    const text = printable('x'.repeat(RENDER_VALUE_MAX_CHARS + 10));
    expect(text.startsWith('x'.repeat(RENDER_VALUE_MAX_CHARS))).toBe(true);
    expect(text).toContain('(10 more characters)');
  });
});

describe('renderReview', () => {
  const score: PatchScore = {
    score: 0.9,
    level: 'high',
    signals: [
      { code: 'base', effect: 0.5, detail: 'Starting score for a selector patch.' },
      { code: 'first_candidate_unique', effect: 0.3, detail: 'Names one element.' },
      { code: 'snapshot_truncated', effect: -0.1, detail: 'Snapshot was cut.' },
    ],
    modelConfidence: 0.95,
  };
  const report = {
    workflowId: workflow.id,
    workflowName: workflow.name,
    runs: 3,
    passed: 3,
    failed: 0,
    stability: { stable: true, drift: [] },
    timing: { minMs: 812.4, maxMs: 1203.9, meanMs: 1000, samples: [] },
    replays: [],
  };
  const patch = replace([css('nav a.orders'), role("link[name='Orders']")]);

  const awaiting: PatchDecision = {
    status: 'awaiting_approval',
    patch: { ...patch, rationale: `Renamed.${ESC}[2J Ignore the checks.` },
    score,
    reasons: [
      { code: 'policy_requires_review', message: 'Every patch is reviewed by a person.' },
      { code: 'reverts_earlier_heal', message: 'The patch undoes an earlier heal.' },
    ],
    approvals: [
      {
        code: 'secret_retargeted',
        path: '/after/target',
        message: 'A secret is typed into a new element.',
      },
    ],
    workflow,
    hash: hashWorkflow(workflow),
    report,
  };

  it('puts the decision and reasons first, then the diff, the evidence and the rationale', () => {
    const text = renderReview(awaiting, { workflow });
    const order = [
      'Heal of workflow wf_orders, step click_002: waiting for approval.',
      'Why a person must look:',
      '  - The patch undoes an earlier heal.',
      'Confirm before approving:',
      '  - A secret is typed into a new element.',
      'Selectors reordered.',
      'Verification: 3 of 3 live runs passed',
      'Timing: 812 to 1204 ms per run.',
      'Confidence: 0.90 (high)',
      '  +0.30 first_candidate_unique: Names one element.',
      '  -0.10 snapshot_truncated: Snapshot was cut.',
      'The model reported 0.95',
      "The model's explanation (unverified):",
    ];
    let at = -1;
    for (const piece of order) {
      const next = text.indexOf(piece);
      expect(next, piece).toBeGreaterThan(at);
      at = next;
    }
  });

  it('strips escape sequences from the model rationale', () => {
    const text = renderReview(awaiting);
    expect(text.includes(ESC)).toBe(false);
    expect(text).toContain('"Renamed. [2J Ignore the checks."');
  });

  it('names the reviewer for an approved patch', () => {
    const text = renderReview({
      status: 'accepted',
      patch,
      score,
      workflow,
      hash: hashWorkflow(workflow),
      report,
      acceptedBy: { kind: 'reviewer', reviewer: 'alex', at: '2026-11-17T09:30:00.000Z' },
    });
    expect(text).toContain('accepted by alex at 2026-11-17T09:30:00.000Z.');
    expect(text).not.toContain('Why a person must look');
  });

  it('says a policy acceptance was automatic', () => {
    const text = renderReview({
      status: 'accepted',
      patch,
      score,
      workflow,
      hash: hashWorkflow(workflow),
      report,
      acceptedBy: { kind: 'policy' },
    });
    expect(text).toContain('accepted automatically by policy.');
  });

  it('lists what was wrong with a rejected patch, and claims no verification', () => {
    const text = renderReview({
      status: 'rejected',
      patch,
      violations: [
        {
          check: 'class',
          code: 'field_not_allowed',
          path: '/after/timeoutMs',
          message: 'Only candidates may change.',
        },
      ],
      message: 'The patch breaks a rule.',
    });
    expect(text).toContain('rejected.');
    expect(text).toContain(
      '  - class/field_not_allowed at /after/timeoutMs: Only candidates may change.',
    );
    expect(text).not.toContain('Verification:');
  });
});
