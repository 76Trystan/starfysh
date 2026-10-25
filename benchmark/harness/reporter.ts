import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskRun } from './runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface BenchmarkReport {
  timestamp: string;
  durationMs: number;
  taskCount: number;
  passed: number;
  failed: number;
  tasks: TaskRun[];
}

export async function writeReport(tasks: TaskRun[], totalDurationMs: number): Promise<string> {
  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    durationMs: totalDurationMs,
    taskCount: tasks.length,
    passed: tasks.filter((t) => t.status === 'ok').length,
    failed: tasks.filter((t) => t.status === 'failed').length,
    tasks,
  };

  const resultsDir = join(__dirname, '..', 'results');
  await mkdir(resultsDir, { recursive: true });

  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const path = join(resultsDir, filename);
  await writeFile(path, JSON.stringify(report, null, 2), 'utf-8');
  return path;
}
