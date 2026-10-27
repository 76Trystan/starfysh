import type { Browser } from 'playwright-core';
import { asPage } from '@sfysh/playwright-adapter';
import { run, drainOutputs } from '@sfysh/runtime';

export interface TaskRun {
  workflowId: string;
  status: 'ok' | 'failed';
  durationMs: number;
  costUsd: number;
  output: unknown[];
  error?: { kind: string; message: string };
}

export async function runTask(browser: Browser, workflowId: string): Promise<TaskRun> {
  const page = await browser.newPage();
  try {
    const result = await run(workflowId, asPage(page));
    const output = drainOutputs();
    return {
      workflowId,
      status: result.status,
      durationMs: result.durationMs,
      costUsd: 0,
      output,
      error: result.error ? { kind: result.error.kind, message: result.error.message } : undefined,
    };
  } finally {
    await page.close();
  }
}
