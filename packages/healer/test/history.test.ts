import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HEAL_WINDOW_MS, JsonlHealHistory } from '../src/index.js';
import type { PatchRecord } from '../src/index.js';

const dirs: string[] = [];
async function historyFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sfysh-history-'));
  dirs.push(dir);
  return join(dir, 'nested', 'heal-history.jsonl');
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const now = new Date('2026-11-18T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);

const record: PatchRecord = {
  workflowId: 'wf_orders',
  at: hoursAgo(30),
  stepId: 'click_002',
  op: 'replace',
  fromHash: 'sha256:aaa',
  toHash: 'sha256:bbb',
  stepBefore: 'sha256:ccc',
  firstCandidateBefore: { kind: 'role', value: "link[name='Orders']" },
  decision: 'awaiting_approval',
};

describe('JsonlHealHistory', () => {
  it('starts empty when the file does not exist', async () => {
    const history = new JsonlHealHistory({ file: await historyFile() });
    expect(await history.count('wf_orders', new Date(0))).toBe(0);
    expect(await history.patches('wf_orders')).toEqual([]);
  });

  it('counts runs per workflow since a time, across instances', async () => {
    const file = await historyFile();
    const first = new JsonlHealHistory({ file });
    await first.record('wf_orders', hoursAgo(30));
    await first.record('wf_orders', hoursAgo(2));
    await first.record('wf_other', hoursAgo(1));

    const second = new JsonlHealHistory({ file });
    const since = new Date(now.getTime() - HEAL_WINDOW_MS);
    expect(await second.count('wf_orders', since)).toBe(1);
    expect(await second.count('wf_orders', new Date(0))).toBe(2);
    expect(await second.count('wf_other', since)).toBe(1);
  });

  it('reads patch records back with their dates as dates', async () => {
    const file = await historyFile();
    await new JsonlHealHistory({ file }).recordPatch(record);
    const patches = await new JsonlHealHistory({ file }).patches('wf_orders');
    expect(patches).toEqual([record]);
    expect(patches[0]!.at).toBeInstanceOf(Date);
    expect(await new JsonlHealHistory({ file }).patches('wf_other')).toEqual([]);
  });

  it('prunes runs older than the window and keeps every patch record', async () => {
    const file = await historyFile();
    const history = new JsonlHealHistory({ file });
    await history.record('wf_orders', hoursAgo(30));
    await history.record('wf_orders', hoursAgo(2));
    await history.recordPatch(record);
    await appendFile(file, '{"kind":"run","workflowId":\n', 'utf8');

    await history.prune(now);

    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(await history.count('wf_orders', new Date(0))).toBe(1);
    expect(await history.patches('wf_orders')).toEqual([record]);
  });

  it('skips torn and malformed lines instead of failing', async () => {
    const file = await historyFile();
    const history = new JsonlHealHistory({ file });
    await history.record('wf_orders', hoursAgo(1));
    await appendFile(
      file,
      [
        'not json',
        '{"kind":"run","workflowId":"wf_orders","at":"yesterday"}',
        '{"kind":"patch","workflowId":"wf_orders","at":"2026-11-18T00:00:00Z"}',
        '{"kind":"run","workflowId":"wf_orders"',
      ].join('\n'),
      'utf8',
    );
    expect(await history.count('wf_orders', new Date(0))).toBe(1);
    expect(await history.patches('wf_orders')).toEqual([]);
  });
});
