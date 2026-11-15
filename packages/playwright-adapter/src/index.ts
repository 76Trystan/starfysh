// Starfysh-to-Playwright compatibility adapter.
//
// Playwright's Page and Locator types are structural supersets of Starfysh's
// Page and Locator interfaces for every action and query method, so those
// calls pass straight through. The one thing Playwright's Page does not have
// under Starfysh's name is `snapshot()`, which the runtime calls after a
// failure to record the page's accessibility tree. `asPage` adds it.
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

const wrapped = new WeakMap<object, Page>();

/**
 * Present a Playwright Page as Starfysh's Page interface.
 *
 * The result is a thin proxy over the Playwright page. Every existing
 * method and property is forwarded to the real page unchanged, so the
 * object still works anywhere a Playwright page does. The proxy adds one
 * method, `snapshot()`, which returns the accessibility tree of the
 * document body as text (Playwright's ARIA snapshot). The runtime calls it
 * after a failed run so the failure report records what the page looked
 * like.
 *
 * Calling `asPage` twice with the same page returns the same proxy. A page
 * that already has a `snapshot` method is returned as is.
 */
export function asPage(page: PlaywrightPage): Page {
  const existing = wrapped.get(page);
  if (existing) return existing;
  if (typeof (page as unknown as { snapshot?: unknown }).snapshot === 'function') {
    return page as unknown as Page;
  }

  const snapshot = (): Promise<string> => page.locator('body').ariaSnapshot();
  const proxy = new Proxy(page, {
    get(target, prop) {
      if (prop === 'snapshot') return snapshot;
      // Read with the real page as receiver and bind methods to it.
      // Playwright's objects keep internal state on the instance, and a
      // method invoked with the proxy as `this` would not find it.
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
    has(target, prop) {
      return prop === 'snapshot' || Reflect.has(target, prop);
    },
  }) as unknown as Page;

  wrapped.set(page, proxy);
  return proxy;
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
 * throws on failure so the test is marked failed. The thrown error keeps
 * the original name, message, and stack, with vault secrets redacted.
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
      // Throw a fresh error built from the redacted message. Re-throwing the
      // original would hand its unredacted message and stack to the test
      // reporter, and from there to CI logs. Playwright quotes filled values
      // in its call log, so that text can contain a vault secret.
      const cause = result.error?.cause;
      const failure = new Error(result.error?.message ?? 'Workflow failed');
      if (cause instanceof Error) {
        failure.name = cause.name;
        if (cause.stack) failure.stack = ctx.redact(cause.stack);
      }
      throw failure;
    }
  });
}
