// Starfysh-to-Playwright compatibility adapter.
//
// Playwright's Page and Locator types are structural supersets of Starfysh's
// Page and Locator interfaces, so no wrapper logic is needed at runtime.
// The adapter's job is to make the type relationship explicit and to give
// Playwright users a clean import path.
//
// Usage in a Playwright test:
//   import { asPage } from '@sfysh/playwright-adapter';
//   import { workflow, createWorkflowContext } from '@sfysh/runtime';
//   import type { Page } from 'playwright-core';
//
//   test('run workflow', async ({ page }) => {
//     const ctx = createWorkflowContext({ page: asPage(page) });
//     await workflow('wf_my_task', async (ctx) => { ... });
//     // or: run the workflow with a Playwright page:
//     const fn = getWorkflow('wf_my_task');
//     await fn?.(ctx);
//   });

import type { Page as PlaywrightPage, Locator as PlaywrightLocator } from 'playwright-core';
import type { Page, Locator, VaultResolver } from '@sfysh/runtime';
import { createWorkflowContext, run } from '@sfysh/runtime';

/**
 * Cast a Playwright Page to Starfysh's Page interface. Playwright's Page is a
 * structural superset -- all Starfysh methods are present -- so this is safe
 * at runtime. The cast exists to satisfy TypeScript when the types are in
 * separate packages.
 */
export function asPage(page: PlaywrightPage): Page {
  return page as unknown as Page;
}

/**
 * Cast a Playwright Locator to Starfysh's Locator interface. Same structural
 * superset relationship as asPage.
 */
export function asLocator(locator: PlaywrightLocator): Locator {
  return locator as unknown as Locator;
}

/**
 * Minimal type for the Playwright test() function. Satisfied structurally by
 * the test fixture from @playwright/test, keeping this adapter free of a
 * hard dependency on the test framework itself.
 */
export type PlaywrightTestFn = (
  title: string,
  fn: (fixtures: { page: PlaywrightPage }) => Promise<void>,
) => void;

/**
 * Register a Starfysh workflow as a Playwright test. Pass the `test` object
 * from @playwright/test and the workflow id; the helper constructs a per-run
 * WorkflowContext from Playwright's page fixture, executes the workflow, and
 * re-throws any failure so the test is marked failed with the original
 * error.
 *
 * Usage:
 *   import { test } from '@playwright/test';
 *   import { wrapWorkflowForTest } from '@sfysh/playwright-adapter';
 *   import './my-workflow.js'; // registers the workflow as a side effect
 *
 *   wrapWorkflowForTest(test, 'my-workflow');
 */
export function wrapWorkflowForTest(
  test: PlaywrightTestFn,
  workflowId: string,
  options?: { title?: string; vaultResolver?: VaultResolver },
): void {
  test(options?.title ?? workflowId, async ({ page }) => {
    const ctx = createWorkflowContext({
      page: asPage(page),
      ...(options?.vaultResolver ? { vaultResolver: options.vaultResolver } : {}),
    });
    const result = await run(workflowId, ctx);
    if (result.status === 'failed') {
      const cause = result.error?.cause;
      throw cause instanceof Error ? cause : new Error(result.error?.message ?? 'Workflow failed');
    }
  });
}
