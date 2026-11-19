import { describe, expect, it } from 'vitest';
import {
  CORPUS_VERSION,
  corpusReport,
  labelRecord,
  parseCorpus,
  renderReport,
  reviewRecord,
} from '../src/index.js';
import type {
  CorpusAttempt,
  CorpusRecord,
  HealCorpusRecord,
  LabelVerdict,
  PatchClass,
} from '../src/index.js';

let clock = 0;
const tick = () => new Date(Date.UTC(2026, 10, 18, 0, 0, clock++));

interface HealOptions {
  workflowId?: string;
  patchClass?: PatchClass;
  /** Decision on the verified patch. Absent: no verified patch. */
  decision?: 'accepted' | 'awaiting_approval';
  score?: number;
  wouldAutoAccept?: boolean;
  envelope?: 'within' | 'outside';
  trigger?: 'failure' | 'degraded';
  status?: HealCorpusRecord['outcome']['status'];
  tokens?: number;
}

function healRec(id: string, o: HealOptions = {}): HealCorpusRecord {
  const attempts: CorpusAttempt[] = [];
  if (o.decision !== undefined) {
    attempts.push({
      patchClass: o.patchClass ?? 'selector',
      status: 'patch',
      score: { score: o.score ?? 0.9, level: 'high', signals: [] },
      verification: {
        status: 'verified',
        ...(o.envelope ? { envelope: { status: o.envelope, runs: 10 } } : {}),
      },
      decision: { status: o.decision },
      ...(o.wouldAutoAccept !== undefined
        ? {
            wouldAutoAccept: {
              policy: { mode: 'auto', minScore: 0.8 },
              eligible: o.wouldAutoAccept,
              reasons: o.wouldAutoAccept ? [] : ['score_below_threshold'],
            },
          }
        : {}),
    });
  }
  return {
    corpusVersion: CORPUS_VERSION,
    kind: 'heal',
    id,
    at: tick().toISOString(),
    workflowId: o.workflowId ?? 'wf_a',
    workflowHash: 'sha256:x',
    irVersion: '1.0.0',
    trigger: o.trigger ?? 'failure',
    knownGoodHash: 'sha256:y',
    policy: { mode: 'human' },
    attempts,
    outcome:
      o.decision !== undefined
        ? { status: 'decided', decision: o.decision, patchClass: o.patchClass ?? 'selector' }
        : { status: o.status ?? 'not_healed' },
    usage: { inputTokens: o.tokens ?? 0, outputTokens: 0 },
  };
}

const ref = (id: string, workflowId = 'wf_a') => ({ id, workflowId });
const review = (id: string, verdict: 'approved' | 'rejected' | 'reverted', workflowId?: string) =>
  reviewRecord({ heal: ref(id, workflowId), verdict, reviewer: 'dana', at: tick() });
const label = (id: string, verdict: LabelVerdict, workflowId?: string) =>
  labelRecord({ heal: ref(id, workflowId), verdict, source: 'benchmark', at: tick() });

describe('corpusReport: the false-heal rate', () => {
  it('is false heals over labelled verified heals, with unlabelled counted and not assumed correct', () => {
    const records: CorpusRecord[] = [
      healRec('h1', { decision: 'awaiting_approval' }),
      healRec('h2', { decision: 'awaiting_approval' }),
      healRec('h3', { decision: 'awaiting_approval' }),
      healRec('h4', { decision: 'awaiting_approval' }),
      healRec('h5'), // not verified: never counts
      label('h1', 'correct'),
      label('h2', 'correct'),
      label('h3', 'false_heal'),
      label('h5', 'false_heal'),
    ];
    const { falseHeal } = corpusReport(records).overall;
    expect(falseHeal).toEqual({
      falseHeals: 1,
      correct: 2,
      unknown: 0,
      unlabelled: 1,
      rate: 1 / 3,
      appliedFalseHeals: 0,
    });
  });

  it('counts false heals that reached the workflow separately, and uses the latest label', () => {
    const records: CorpusRecord[] = [
      healRec('h1', { decision: 'accepted' }), // applied by policy
      healRec('h2', { decision: 'awaiting_approval' }),
      review('h2', 'approved'), // applied by a person
      label('h1', 'correct'),
      label('h1', 'false_heal'), // the later label wins
      label('h2', 'false_heal'),
    ];
    const s = corpusReport(records).overall;
    expect(s.applied).toEqual({ total: 2, byPolicy: 1, byReviewer: 1 });
    expect(s.falseHeal).toMatchObject({ falseHeals: 2, correct: 0, appliedFalseHeals: 2, rate: 1 });
  });

  it('is null, not zero, when nothing is labelled', () => {
    const s = corpusReport([healRec('h1', { decision: 'awaiting_approval' })]).overall;
    expect(s.falseHeal.rate).toBeNull();
    expect(
      renderReport(corpusReport([healRec('h1', { decision: 'awaiting_approval' })])),
    ).toContain('False-heal rate: not measured');
  });
});

describe('corpusReport: shadow agreement', () => {
  it('fills the four cells, counting a revert or a false-heal label as a no', () => {
    const records: CorpusRecord[] = [
      healRec('aa', { decision: 'awaiting_approval', wouldAutoAccept: true }),
      review('aa', 'approved'),
      healRec('ar', { decision: 'awaiting_approval', wouldAutoAccept: true }),
      review('ar', 'rejected'),
      healRec('av', { decision: 'awaiting_approval', wouldAutoAccept: true }),
      review('av', 'approved'),
      review('av', 'reverted'),
      healRec('af', { decision: 'awaiting_approval', wouldAutoAccept: true }),
      review('af', 'approved'),
      label('af', 'false_heal'),
      healRec('ha', { decision: 'awaiting_approval', wouldAutoAccept: false }),
      review('ha', 'approved'),
      healRec('hr', { decision: 'awaiting_approval', wouldAutoAccept: false }),
      review('hr', 'rejected'),
      healRec('wait', { decision: 'awaiting_approval', wouldAutoAccept: true }),
      healRec('promo', { decision: 'accepted', patchClass: 'promotion' }), // no shadow verdict
    ];
    expect(corpusReport(records).overall.shadow).toEqual({
      acceptedAndApproved: 1,
      acceptedButRejected: 3,
      heldButApproved: 1,
      heldAndRejected: 1,
      awaitingAnswer: 1,
      agreement: 2 / 6,
    });
  });
});

describe('corpusReport: grouping and other counts', () => {
  const records: CorpusRecord[] = [
    healRec('s1', { decision: 'awaiting_approval', score: 0.9, tokens: 1000 }),
    review('s1', 'rejected'),
    healRec('s2', { decision: 'awaiting_approval', score: 0.6, envelope: 'outside', tokens: 500 }),
    healRec('s3', { decision: 'awaiting_approval', score: 0.3, workflowId: 'wf_b' }),
    label('s3', 'false_heal', 'wf_b'),
    healRec('p1', { decision: 'accepted', patchClass: 'promotion', trigger: 'degraded' }),
    healRec('r1', { status: 'routed' }),
    review('ghost', 'approved'),
  ];
  const report = corpusReport(records);

  it('counts outcomes, triggers, pending, possible false heals, tokens and orphans', () => {
    const s = report.overall;
    expect(s.heals).toBe(5);
    expect(s.byTrigger).toEqual({ failure: 4, degraded: 1 });
    expect(s.outcomes).toEqual({ decided: 4, routed: 1 });
    expect(s.verified).toBe(4);
    expect(s.pending).toBe(2);
    expect(s.rejected).toBe(1);
    expect(s.possiblyFalseHeals).toBe(1);
    expect(s.tokens).toEqual({ input: 1500, output: 0 });
    expect(report.orphans).toBe(1);
  });

  it('puts each verified heal in a score band with its outcome', () => {
    expect(report.overall.scoreBands).toEqual([
      {
        band: 'below 0.5',
        heals: 1,
        approved: 0,
        rejected: 0,
        reverted: 0,
        falseHeals: 1,
        correct: 0,
      },
      {
        band: '0.5 to 0.8',
        heals: 1,
        approved: 0,
        rejected: 0,
        reverted: 0,
        falseHeals: 0,
        correct: 0,
      },
      {
        band: '0.8 and above',
        heals: 2,
        approved: 0,
        rejected: 1,
        reverted: 0,
        falseHeals: 0,
        correct: 0,
      },
    ]);
  });

  it('splits by workflow and by patch class, keeping promotions apart from model heals', () => {
    expect(Object.keys(report.byWorkflow)).toEqual(['wf_a', 'wf_b']);
    expect(report.byWorkflow['wf_b']!.falseHeal.falseHeals).toBe(1);
    expect(report.byPatchClass.promotion!.applied.byPolicy).toBe(1);
    expect(report.byPatchClass.selector!.heals).toBe(3);
  });

  it('renders every section, and one workflow on request', () => {
    const text = renderReport(report);
    expect(text).toContain('All workflows');
    expect(text).toContain('Patch class promotion');
    expect(text).toContain('Workflow wf_b');
    expect(text).toContain('Score below 0.5: 1 heals');
    expect(text).toContain('1 review or label records point at heals not in the corpus');
    expect(renderReport(report, { workflow: 'wf_b' })).toContain('False-heal rate: 100.0% (1 of 1');
    expect(renderReport(report, { workflow: 'nope' })).toBe('No heals recorded for workflow nope.');
  });
});

describe('label records', () => {
  it('requires a named reviewer for a reviewer label', () => {
    expect(() =>
      labelRecord({ heal: ref('h1'), verdict: 'false_heal', source: 'reviewer', reviewer: ' ' }),
    ).toThrow(TypeError);
    expect(
      labelRecord({ heal: ref('h1'), verdict: 'false_heal', source: 'reviewer', reviewer: 'dana' }),
    ).toMatchObject({ kind: 'label', healId: 'h1', verdict: 'false_heal', reviewer: 'dana' });
  });

  it('are read back from a corpus file, and a bad verdict is reported', () => {
    const good = label('h1', 'correct');
    const text = [JSON.stringify(good), JSON.stringify({ ...good, verdict: 'maybe' })].join('\n');
    const read = parseCorpus(text);
    expect(read.records).toEqual([good]);
    expect(read.problems[0]!.message).toContain('Unknown label verdict');
  });
});

describe('corpusReport: partial heals', () => {
  it('counts a heal whose patch only progressed as verified, and says how many were partial', () => {
    const partial = healRec('p1', { decision: 'awaiting_approval' });
    partial.attempts[0]!.verification = {
      status: 'progressed',
      failedStepId: 'click_004',
      outputsMatched: 1,
    };
    const report = corpusReport([partial, healRec('v1', { decision: 'awaiting_approval' })]);
    expect(report.overall.verified).toBe(2);
    expect(report.overall.partial).toBe(1);
    expect(renderReport(report)).toContain('Verified: 2 (1 partial).');
  });
});
