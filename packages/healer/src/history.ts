// A `HealHistory` kept in a JSON Lines file, so the daily cap and the
// reversion check hold across processes.
//
// `heal()` needs two things remembered between runs: when heals ran (for
// the cap on heals per workflow per day) and what each decided heal
// changed (to catch a heal that undoes an earlier one). `MemoryHealHistory`
// forgets both when the process exits, which is fine for a long-lived
// scheduler and useless for a command run once per failure.
//
// The two kinds of entry live differently. Run timestamps only matter for
// 24 hours and can be pruned. Patch records must be kept for as long as
// the workflow exists, because a site can flip between two designs over
// weeks. `prune()` drops old runs and keeps every patch record.

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { HealHistory } from './limits.js';
import { HEAL_WINDOW_MS } from './limits.js';
import type { PatchRecord } from './revert.js';

/** Where `JsonlHealHistory` keeps its file when none is given, relative to the working directory. */
export const DEFAULT_HEAL_HISTORY_FILE = '.compile/heal-history.jsonl';

export interface JsonlHealHistoryOptions {
  /** Path of the history file. Default `DEFAULT_HEAL_HISTORY_FILE`. */
  file?: string;
}

type Entry =
  | { kind: 'run'; workflowId: string; at: string }
  | ({ kind: 'patch' } & Omit<PatchRecord, 'at'> & { at: string });

/**
 * A `HealHistory` in a JSON Lines file, read on every call. A line that is
 * not a valid entry (a write cut off by a crash) is skipped rather than
 * failing every later heal.
 *
 * One process at a time. Two heals of the same workflow running at once
 * could both pass the daily cap, as they could with any store that does
 * not lock.
 */
export class JsonlHealHistory implements HealHistory {
  readonly file: string;

  constructor(options: JsonlHealHistoryOptions = {}) {
    this.file = options.file ?? DEFAULT_HEAL_HISTORY_FILE;
  }

  async count(workflowId: string, since: Date): Promise<number> {
    const from = since.getTime();
    const entries = await this.load();
    return entries.filter(
      (e) => e.kind === 'run' && e.workflowId === workflowId && Date.parse(e.at) >= from,
    ).length;
  }

  async record(workflowId: string, at: Date): Promise<void> {
    await this.append({ kind: 'run', workflowId, at: at.toISOString() });
  }

  async patches(workflowId: string): Promise<PatchRecord[]> {
    const entries = await this.load();
    const records: PatchRecord[] = [];
    for (const e of entries) {
      if (e.kind !== 'patch' || e.workflowId !== workflowId) continue;
      const { kind: _kind, at, ...rest } = e;
      records.push({ ...rest, at: new Date(at) });
    }
    return records;
  }

  async recordPatch(record: PatchRecord): Promise<void> {
    await this.append({ kind: 'patch', ...record, at: record.at.toISOString() });
  }

  /**
   * Rewrite the file without run entries older than the 24-hour window.
   * Patch records are always kept. Bad lines are dropped. The new file is
   * written beside the old one and renamed over it, so a crash part-way
   * leaves the old file whole.
   */
  async prune(now: Date = new Date()): Promise<void> {
    const entries = await this.load();
    const cutoff = now.getTime() - HEAL_WINDOW_MS;
    const kept = entries.filter((e) => e.kind === 'patch' || Date.parse(e.at) >= cutoff);
    if (entries.length === 0) return;
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await writeFile(temp, kept.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
    await rename(temp, this.file);
  }

  private async append(entry: Entry): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  private async load(): Promise<Entry[]> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries: Entry[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line === '') continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (isEntry(value)) entries.push(value);
    }
    return entries;
  }
}

function isEntry(value: unknown): value is Entry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  if (typeof e['workflowId'] !== 'string') return false;
  if (typeof e['at'] !== 'string' || Number.isNaN(Date.parse(e['at']))) return false;
  if (e['kind'] === 'run') return true;
  return (
    e['kind'] === 'patch' &&
    typeof e['stepId'] === 'string' &&
    typeof e['fromHash'] === 'string' &&
    typeof e['toHash'] === 'string' &&
    (e['op'] === 'replace' || e['op'] === 'insert_before' || e['op'] === 'insert_after') &&
    (e['decision'] === 'accepted' || e['decision'] === 'awaiting_approval')
  );
}
