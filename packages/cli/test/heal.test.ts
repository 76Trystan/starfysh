import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCorpus } from '@sfysh/healer';
import { applyPatch } from '@sfysh/ir';
import type { Workflow } from '@sfysh/ir';
import type { HealCorpusRecord, ReviewCorpusRecord } from '@sfysh/healer';
import { run } from '../src/index.js';

class StringSink {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  get text(): string {
    return this.chunks.join('');
  }
}

function ctx() {
  return { stdout: new StringSink(), stderr: new StringSink() };
}

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const oldSite = resolvePath(fixturesDir, 'heal-old-site.mjs');
const newSite = resolvePath(fixturesDir, 'heal-new-site.mjs');
const newSiteCannot = resolvePath(fixturesDir, 'heal-new-site-cannot.mjs');
const newSiteNoProvider = resolvePath(fixturesDir, 'heal-new-site-no-provider.mjs');

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
};

describe('compile heal, approve and reject', () => {
  let dir: string;
  let state: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sfysh-cli-heal-'));
    state = join(dir, 'state');
    file = join(dir, 'workflow.json');
    writeFileSync(file, JSON.stringify(workflow, null, 2), 'utf8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function healWith(backend: string, ...extra: string[]) {
    const c = ctx();
    const code = await run(['heal', file, '--backend', backend, '--dir', state, ...extra], c);
    return { code, out: c.stdout.text, err: c.stderr.text };
  }

  async function review(command: 'approve' | 'reject', healId: string, ...extra: string[]) {
    const c = ctx();
    const code = await run([command, healId, '--dir', state, ...extra], c);
    return { code, out: c.stdout.text, err: c.stderr.text };
  }

  function pendingIds(): string[] {
    const pending = join(state, 'pending');
    if (!existsSync(pending)) return [];
    return readdirSync(pending).map((f) => f.replace(/\.json$/, ''));
  }

  /** Run once on the working site to save known-good outputs, then heal on the renamed one. */
  async function heldHeal(): Promise<string> {
    expect((await healWith(oldSite)).code).toBe(0);
    const healed = await healWith(newSite);
    expect(healed.code).toBe(3);
    const [id] = pendingIds();
    return id!;
  }

  it('lists heal, approve and reject in top-level help', () => {
    const c = ctx();
    run(['--help'], c);
    expect(c.stdout.text).toContain('heal <file>');
    expect(c.stdout.text).toContain('approve <id>');
    expect(c.stdout.text).toContain('reject <id>');
  });

  it('prints command help', async () => {
    const c = ctx();
    expect(await run(['heal', '--help'], c)).toBe(0);
    expect(c.stdout.text).toContain('compile heal <file>');
    expect(c.stdout.text).toContain('Exit codes');
  });

  it('says so when the workflow passes only on a fallback selector', async () => {
    const withFallback = structuredClone(workflow);
    withFallback.steps[1]!.target!.candidates.push({
      kind: 'role',
      value: "link[name='My orders']",
    });
    writeFileSync(file, JSON.stringify(withFallback, null, 2), 'utf8');

    const { code, out } = await healWith(newSite);
    expect(code).toBe(0);
    expect(out).toContain('passed, but only on fallback selectors');
    expect(out).toContain('Step click_002: the primary selector failed; candidate #2');
    expect(pendingIds()).toEqual([]);

    const json = await healWith(newSite, '--json');
    expect(JSON.parse(json.out)).toMatchObject({
      status: 'passed',
      degraded: [{ stepId: 'click_002', candidateIndex: 1 }],
    });
  });

  it('saves known-good outputs when the workflow passes and does nothing else', async () => {
    const { code, out } = await healWith(oldSite);
    expect(code).toBe(0);
    expect(out).toContain('Nothing to heal');
    const saved = JSON.parse(readFileSync(join(state, 'known-good', 'wf_orders.json'), 'utf8'));
    expect(saved).toMatchObject({
      workflowId: 'wf_orders',
      outputs: [{ extract_003: 'Order 1042' }],
    });
    expect((await readCorpus(join(state, 'corpus'))).records).toEqual([]);
  });

  it('refuses to heal without known-good outputs', async () => {
    const { code, err } = await healWith(newSite);
    expect(code).toBe(1);
    expect(err).toContain('no known-good outputs');
    expect(pendingIds()).toEqual([]);
  });

  it('holds a verified patch for approval, prints the review, and records the heal', async () => {
    expect((await healWith(oldSite)).code).toBe(0);
    const { code, out } = await healWith(newSite);

    expect(code).toBe(3);
    expect(out).toContain('waiting for approval');
    expect(out).toContain("link[name='My orders']");
    const [id] = pendingIds();
    expect(out).toContain(`compile approve ${id}`);

    const { records } = await readCorpus(join(state, 'corpus'));
    expect(records).toHaveLength(1);
    const record = records[0] as HealCorpusRecord;
    expect(record.id).toBe(id);
    expect(record.outcome).toMatchObject({ status: 'decided', decision: 'awaiting_approval' });
    expect(record.attempts[0]!.model).toBe('fake-model-2026');

    // Nothing is applied yet.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(workflow);
  });

  it('applies the patch on approval, records the reviewer, and the workflow then passes', async () => {
    const id = await heldHeal();
    const approved = await review('approve', id, '--reviewer', 'dana');

    expect(approved.code).toBe(0);
    expect(approved.out).toContain(`Approved heal ${id}`);
    const patched = JSON.parse(readFileSync(file, 'utf8'));
    expect(patched.steps[1].target.candidates[0].value).toBe("link[name='My orders']");
    expect(pendingIds()).toEqual([]);

    const { records } = await readCorpus(join(state, 'corpus'));
    const reviewed = records[1] as ReviewCorpusRecord;
    expect(reviewed).toMatchObject({
      kind: 'review',
      healId: id,
      verdict: 'approved',
      reviewer: 'dana',
    });

    expect((await healWith(newSite)).code).toBe(0);
  });

  it('writes the patched workflow elsewhere with --out', async () => {
    const id = await heldHeal();
    const out = join(dir, 'patched.json');
    expect((await review('approve', id, '--reviewer', 'dana', '--out', out)).code).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(workflow);
    expect(JSON.parse(readFileSync(out, 'utf8')).steps[1].target.candidates[0].value).toBe(
      "link[name='My orders']",
    );
  });

  it('rejects a pending heal without touching the workflow', async () => {
    const id = await heldHeal();
    const rejected = await review('reject', id, '--reviewer', 'dana', '--note', 'Wrong link.');

    expect(rejected.code).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(workflow);
    expect(pendingIds()).toEqual([]);
    const { records } = await readCorpus(join(state, 'corpus'));
    expect(records[1]).toMatchObject({ verdict: 'rejected', note: 'Wrong link.' });
  });

  it('refuses to approve when the workflow file changed since the heal', async () => {
    const id = await heldHeal();
    const edited = { ...workflow, name: 'Read the newest order' };
    writeFileSync(file, JSON.stringify(edited, null, 2), 'utf8');

    const approved = await review('approve', id, '--reviewer', 'dana');
    expect(approved.code).toBe(1);
    expect(approved.err).toContain('changed since this patch was verified');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(edited);
    expect(pendingIds()).toEqual([id]);
  });

  describe('a pending file edited on disk', () => {
    function tamper(id: string, consistent: boolean): void {
      const path = join(state, 'pending', `${id}.json`);
      const pending = JSON.parse(readFileSync(path, 'utf8'));
      const patch = pending.decision.patch;
      patch.after = {
        id: 'click_002',
        intent: 'Open the orders page.',
        action: 'navigate',
        url: 'https://evil.example.net/',
      };
      if (consistent) {
        // Keep the decision self-consistent, so only the rule checks stand
        // between this patch and the workflow file.
        const applied = applyPatch(workflow as unknown as Workflow, patch);
        if (!applied.ok) throw new Error('fixture patch does not apply');
        pending.decision.workflow = applied.workflow;
        pending.decision.hash = applied.hash;
      }
      writeFileSync(path, JSON.stringify(pending), 'utf8');
    }

    it('is refused when the patch no longer matches the decision', async () => {
      const id = await heldHeal();
      tamper(id, false);
      const approved = await review('approve', id, '--reviewer', 'dana');
      expect(approved.code).toBe(1);
      expect(approved.err).toContain('does not match');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(workflow);
    });

    it('is refused when a consistent edit breaks a rule', async () => {
      const id = await heldHeal();
      tamper(id, true);
      const approved = await review('approve', id, '--reviewer', 'dana');
      expect(approved.code).toBe(1);
      expect(approved.err).toContain('breaks a rule');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(workflow);
    });
  });

  it('refuses an id that is not a heal id, and one that is not pending', async () => {
    const bad = await review('approve', '../../workflow', '--reviewer', 'dana');
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('not a heal id');
    const missing = await review(
      'reject',
      '00000000-0000-4000-8000-000000000000',
      '--reviewer',
      'dana',
    );
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('no pending heal');
  });

  it('requires a reviewer', async () => {
    const result = await review('approve', '00000000-0000-4000-8000-000000000000');
    expect(result.code).toBe(1);
    expect(result.err).toContain('--reviewer');
  });

  it('reports a heal that found no patch, with exit code 2', async () => {
    expect((await healWith(oldSite)).code).toBe(0);
    const { code, out } = await healWith(newSiteCannot);
    expect(code).toBe(2);
    expect(out).toContain('No patch verified');
    expect(out).toContain('model could not heal');
    expect(pendingIds()).toEqual([]);
    const { records } = await readCorpus(join(state, 'corpus'));
    expect((records[0] as HealCorpusRecord).outcome).toEqual({
      status: 'not_healed',
      reason: 'exhausted',
    });
  });

  it('keeps the daily cap across invocations', async () => {
    expect((await healWith(oldSite)).code).toBe(0);
    for (let i = 0; i < 3; i++) {
      expect((await healWith(newSiteCannot)).code).toBe(2);
    }
    const capped = await healWith(newSiteCannot);
    expect(capped.code).toBe(2);
    expect(capped.out).toContain("'heals_per_day' limit");
  });

  it('takes known-good outputs from a file', async () => {
    const goodFile = join(dir, 'good.json');
    writeFileSync(goodFile, JSON.stringify([{ extract_003: 'Order 1042' }]), 'utf8');
    expect((await healWith(newSite, '--known-good', goodFile)).code).toBe(3);
  });

  it('emits JSON with --json', async () => {
    expect((await healWith(oldSite)).code).toBe(0);
    const { code, out } = await healWith(newSite, '--json');
    expect(code).toBe(3);
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ status: 'decided', healId: pendingIds()[0] });
    expect(parsed.record.kind).toBe('heal');
  });

  it('needs a provider from the flag or the backend', async () => {
    expect((await healWith(oldSite)).code).toBe(0);
    const { code, err } = await healWith(newSiteNoProvider);
    expect(code).toBe(1);
    expect(err).toContain('no model provider');
  });

  it('checks its flags', async () => {
    expect((await healWith(newSite, '--provider', 'skynet')).err).toContain('--provider must be');
    expect((await healWith(newSite, '--model', 'x')).err).toContain('--model needs --provider');
    expect((await healWith(newSite, '--runs', '2')).err).toContain('at least 3');
    const c = ctx();
    expect(await run(['heal', file], c)).toBe(1);
    expect(c.stderr.text).toContain('missing --backend');
  });
});
