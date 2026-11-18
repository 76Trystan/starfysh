import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashWorkflow } from '@sfysh/ir';
import type { Workflow } from '@sfysh/ir';
import type { Completion, Provider } from '@sfysh/providers';
import { VaultSecretMissingError } from '@sfysh/runtime';
import type { Locator, Page } from '@sfysh/runtime';
import { interpretWorkflow, replay } from '@sfysh/verifier';
import type { ReplayOutcome } from '@sfysh/verifier';
import {
  CORPUS_FILE,
  CORPUS_VERSION,
  heal,
  healRecord,
  JsonlCorpus,
  MemoryCorpus,
  MemoryHealHistory,
  parseCorpus,
  readCorpus,
  reviewRecord,
} from '../src/index.js';
import type { HealInput, HealResult, HealCorpusRecord, KnownGood } from '../src/index.js';

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
    locator: (selector: string) => locator(selector === 'h1', [site.heading]),
    getByRole: (_role: string, options?: { name?: string }) =>
      locator(site.links.includes(options?.name ?? '')),
    getByTestId: () => locator(false),
    getByText: () => locator(false),
    getByLabel: () => locator(false),
    snapshot: async () =>
      [...site.links.map((l) => `- link "${l}"`), `- heading "${site.heading}" [level=1]`].join(
        '\n',
      ),
  } as unknown as Page;
}

const oldSite: Site = { links: ['Orders'], heading: 'Order 1042' };
const newSite: Site = { links: ['My orders'], heading: 'Order 1042' };
const knownGood: KnownGood = { outputs: [{ extract_003: 'Order 1042' }] };

async function runOn(site: Site): Promise<ReplayOutcome> {
  const report = await replay(workflow, {
    pageFactory: () => sitePage(site),
    runner: interpretWorkflow,
    runs: 1,
  });
  return report.replays[0]!;
}

function scripted(reply: string): Provider {
  return {
    name: 'fake',
    async complete() {
      const completion: Completion = {
        content: reply,
        stopReason: 'end',
        usage: { inputTokens: 1200, outputTokens: 90 },
        model: 'fake-model-2026',
      };
      return completion;
    },
  };
}

const click002 = (workflow.steps as unknown as Loose[])[1]!;

const selectorAnswer = JSON.stringify({
  after: {
    ...click002,
    target: { candidates: [{ kind: 'role', value: "link[name='My orders']" }] },
  },
  rationale: 'The link was renamed.',
  confidence: 0.9,
});

const cannotHeal = JSON.stringify({ cannotHeal: true, rationale: 'Nothing on the page fits.' });

const identity = (text: string) => text;
const fixed = { id: 'heal-1', at: new Date('2026-11-18T09:00:00Z') };

async function healOn(
  site: Site,
  reply: string,
  overrides: Partial<HealInput> = {},
): Promise<{ input: HealInput; result: HealResult }> {
  const input: HealInput = {
    workflow,
    outcome: await runOn(site),
    knownGood,
    provider: scripted(reply),
    redact: identity,
    pageFactory: () => sitePage(site),
    history: new MemoryHealHistory(),
    ...overrides,
  };
  return { input, result: await heal(input) };
}

function recordFor(
  { input, result }: { input: HealInput; result: HealResult },
  extra: { includeOutputs?: boolean; redact?: (text: string) => string } = {},
): HealCorpusRecord {
  return healRecord({
    workflow: input.workflow,
    knownGood: input.knownGood,
    result,
    redact: extra.redact ?? input.redact,
    ...(input.policy !== undefined ? { policy: input.policy } : {}),
    ...(extra.includeOutputs !== undefined ? { includeOutputs: extra.includeOutputs } : {}),
    ...fixed,
  });
}

describe('healRecord', () => {
  it('records a decided heal with the evidence the benchmark and an audit need', async () => {
    const healed = await healOn(newSite, selectorAnswer);
    const record = recordFor(healed);

    expect(record).toMatchObject({
      corpusVersion: CORPUS_VERSION,
      kind: 'heal',
      id: 'heal-1',
      at: '2026-11-18T09:00:00.000Z',
      workflowId: 'wf_orders',
      workflowHash: hashWorkflow(workflow),
      irVersion: '1.0.0',
      failure: { name: 'TimeoutError', stepId: 'click_002', action: 'click' },
      triage: { route: 'heal', retried: false, recovered: false },
      snapshotHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      snapshotTruncated: false,
      knownGoodHash: expect.stringMatching(/^sha256:/),
      policy: { mode: 'human' },
      outcome: { status: 'decided', patchClass: 'selector', decision: 'awaiting_approval' },
      usage: { inputTokens: 1200, outputTokens: 90 },
    });
    expect(record.attempts).toHaveLength(1);
    const attempt = record.attempts[0]!;
    expect(attempt).toMatchObject({
      patchClass: 'selector',
      status: 'patch',
      model: 'fake-model-2026',
      promptHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      usage: { inputTokens: 1200, outputTokens: 90 },
      verification: { status: 'verified', runs: 3, passed: 3, stepRan: 'confirmed' },
      decision: { status: 'awaiting_approval', reasons: ['policy_requires_review'] },
    });
    expect(attempt.patch?.stepId).toBe('click_002');
    expect(attempt.score?.signals.length).toBeGreaterThan(0);
    expect(attempt.score?.score).toBe(attempt.patch?.confidence);
    expect(attempt.verification?.durationsMs).toHaveLength(3);
    // Every run produced the known-good outputs, so the hashes match.
    expect(attempt.verification?.outputHashes).toEqual([
      record.knownGoodHash,
      record.knownGoodHash,
      record.knownGoodHash,
    ]);
    expect(record.outcome.hash).toBe(attempt.verification?.hash);
  });

  it('keeps page content out by default: no snapshot text and no outputs', async () => {
    const record = recordFor(await healOn(newSite, selectorAnswer));
    const line = JSON.stringify(record);
    expect(line).not.toContain('Order 1042');
    expect(line).not.toContain('heading');
    expect(record.knownGoodOutputs).toBeUndefined();
  });

  it('keeps the known-good outputs, redacted, when asked', async () => {
    const record = recordFor(await healOn(newSite, selectorAnswer), {
      includeOutputs: true,
      redact: (text) => text.replaceAll('1042', '[redacted]'),
    });
    expect(record.knownGoodOutputs).toEqual([{ extract_003: 'Order [redacted]' }]);
  });

  it('passes every string through redact', async () => {
    const record = recordFor(await healOn(newSite, selectorAnswer), {
      redact: (text) => text.replaceAll('Timeout', '[secret]').replaceAll('renamed', '[secret]'),
    });
    const line = JSON.stringify(record);
    expect(line).not.toContain('Timeout');
    expect(line).not.toContain('renamed');
    expect(record.failure?.message).toContain('[secret]');
    expect(record.attempts[0]!.patch?.rationale).toContain('[secret]');
  });

  it('refuses a redactor that does not return a string', async () => {
    const healed = await healOn(newSite, selectorAnswer);
    expect(() =>
      recordFor(healed, { redact: (() => undefined) as unknown as (text: string) => string }),
    ).toThrow(TypeError);
  });

  it('records a policy the heal ran under', async () => {
    const record = recordFor(
      await healOn(newSite, selectorAnswer, { policy: { mode: 'auto', minScore: 0.8 } }),
    );
    expect(record.policy).toEqual({ mode: 'auto', minScore: 0.8 });
    expect(record.attempts[0]!.decision).toMatchObject({
      status: 'accepted',
      acceptedBy: { kind: 'policy' },
    });
  });

  it('records a failed verification with drift paths but not drift values', async () => {
    const healed = await healOn(newSite, selectorAnswer, {
      knownGood: { outputs: [{ extract_003: 'Order 9999' }] },
    });
    const record = recordFor(healed);
    const verification = record.attempts[0]!.verification;
    expect(verification?.status).toBe('failed');
    expect(verification?.failures).toContainEqual({
      code: 'output_mismatch',
      run: 0,
      paths: expect.any(Array),
    });
    const line = JSON.stringify(record);
    expect(line).not.toContain('Order 9999');
    expect(line).not.toContain('Order 1042');
  });

  it('records the model explanation when it cannot heal', async () => {
    const record = recordFor(await healOn(newSite, cannotHeal));
    expect(record.outcome).toEqual({ status: 'not_healed', reason: 'exhausted' });
    expect(record.attempts.map((a) => a.status)).toEqual(['cannot_heal', 'cannot_heal']);
    expect(record.attempts[0]!.rationale).toBe('Nothing on the page fits.');
    expect(record.attempts[0]!.patch).toBeUndefined();
  });

  it('records a routed failure with no attempts and no tokens', async () => {
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
    const record = recordFor(
      await healOn(newSite, selectorAnswer, { outcome: report.replays[0]! }),
    );
    expect(record.outcome).toEqual({ status: 'routed', route: 'reauthenticate' });
    expect(record.triage.route).toBe('reauthenticate');
    expect(record.attempts).toEqual([]);
    expect(record.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(record.failure?.name).toBe('VaultSecretMissingError');
  });

  it('records a recovered heal without a failure or snapshot', async () => {
    const record = recordFor(
      await healOn(newSite, selectorAnswer, { retry: () => runOn(oldSite) }),
    );
    expect(record.outcome).toEqual({ status: 'recovered' });
    expect(record.triage).toMatchObject({ retried: true, recovered: true });
    expect(record.failure).toBeUndefined();
    expect(record.snapshotHash).toBeUndefined();
  });

  it('gives each record a fresh id by default', async () => {
    const healed = await healOn(newSite, cannotHeal);
    const base = { workflow, knownGood, result: healed.result, redact: identity };
    expect(healRecord(base).id).not.toBe(healRecord(base).id);
  });
});

describe('reviewRecord', () => {
  const healRef = { id: 'heal-1', workflowId: 'wf_orders' };

  it('points at the heal and names the reviewer', () => {
    expect(
      reviewRecord({
        heal: healRef,
        verdict: 'rejected',
        reviewer: '  dana  ',
        note: 'Wrong link: this opens archived orders.',
        id: 'review-1',
        at: new Date('2026-11-18T10:00:00Z'),
      }),
    ).toEqual({
      corpusVersion: CORPUS_VERSION,
      kind: 'review',
      id: 'review-1',
      at: '2026-11-18T10:00:00.000Z',
      healId: 'heal-1',
      workflowId: 'wf_orders',
      verdict: 'rejected',
      reviewer: 'dana',
      note: 'Wrong link: this opens archived orders.',
    });
  });

  it('refuses a blank reviewer', () => {
    expect(() => reviewRecord({ heal: healRef, verdict: 'approved', reviewer: ' ' })).toThrow(
      TypeError,
    );
  });

  it('redacts the note when given a redactor', () => {
    const record = reviewRecord({
      heal: healRef,
      verdict: 'approved',
      reviewer: 'dana',
      note: 'Password hunter2 still works.',
      redact: (text) => text.replaceAll('hunter2', '[secret]'),
    });
    expect(record.note).toBe('Password [secret] still works.');
  });
});

describe('MemoryCorpus', () => {
  it('keeps copies of what it is given', async () => {
    const corpus = new MemoryCorpus();
    const record = recordFor(await healOn(newSite, cannotHeal));
    corpus.write(record);
    record.workflowId = 'changed';
    expect(corpus.records[0]!.workflowId).toBe('wf_orders');
  });
});

describe('JsonlCorpus and readCorpus', () => {
  const dirs: string[] = [];
  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'sfysh-corpus-'));
    dirs.push(dir);
    return dir;
  }
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('creates the directory and appends one line per record, readable in order', async () => {
    const dir = join(await tempDir(), 'nested', 'corpus');
    const corpus = new JsonlCorpus({ dir });
    const heal1 = recordFor(await healOn(newSite, selectorAnswer));
    const review = reviewRecord({ heal: heal1, verdict: 'approved', reviewer: 'dana' });
    await corpus.write(heal1);
    await corpus.write(review);

    const text = await readFile(join(dir, CORPUS_FILE), 'utf8');
    expect(text.split('\n')).toHaveLength(3);
    expect(text.endsWith('\n')).toBe(true);

    const read = await readCorpus(dir);
    expect(read.problems).toEqual([]);
    expect(read.records).toEqual([heal1, review]);
  });

  it('writes concurrent records without losing any', async () => {
    const dir = await tempDir();
    const corpus = new JsonlCorpus({ dir });
    const healRef = { id: 'heal-1', workflowId: 'wf_orders' };
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        corpus.write(reviewRecord({ heal: healRef, verdict: 'approved', reviewer: `r${i}` })),
      ),
    );
    const read = await readCorpus(dir);
    expect(read.records).toHaveLength(20);
    expect(read.problems).toEqual([]);
  });

  it('reads a missing corpus as empty', async () => {
    expect(await readCorpus(join(await tempDir(), 'none'))).toEqual({
      records: [],
      problems: [],
    });
  });

  it('skips torn, foreign and malformed lines and says which', async () => {
    const dir = await tempDir();
    const good = reviewRecord({
      heal: { id: 'heal-1', workflowId: 'wf_orders' },
      verdict: 'approved',
      reviewer: 'dana',
    });
    const lines = [
      JSON.stringify(good),
      JSON.stringify({ ...good, corpusVersion: 2 }),
      JSON.stringify({ ...good, kind: 'note' }),
      JSON.stringify({ ...good, healId: undefined }),
      '[1, 2]',
      '',
      '{"corpusVersion":1,"kind":"heal","id":"x"',
    ];
    await writeFile(join(dir, CORPUS_FILE), lines.join('\n'), 'utf8');

    const read = await readCorpus(dir);
    expect(read.records).toEqual([good]);
    expect(read.problems.map((p) => p.line)).toEqual([2, 3, 4, 5, 7]);
    expect(read.problems[0]!.message).toContain('version');
    expect(read.problems[4]!.message).toBe('Not valid JSON.');
  });

  it('parses Windows line endings', () => {
    const good = reviewRecord({
      heal: { id: 'heal-1', workflowId: 'wf_orders' },
      verdict: 'approved',
      reviewer: 'dana',
    });
    const text = `${JSON.stringify(good)}\r\n${JSON.stringify(good)}\r\n`;
    expect(parseCorpus(text).records).toHaveLength(2);
  });
});
