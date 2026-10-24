// Starfysh-to-Playwright compatibility adapter.
//
// Playwright's Page and Locator types are structural supersets of Starfysh's
// Page and Locator interfaces, so no wrapper logic is needed at runtime.
// The adapter's job is to make the type relationship explicit and to give
// Playwright users a clean import path.
//
// Usage in a Playwright test:
//   import { asPage } from '@asc/playwright-adapter';
//   import { workflow } from '@asc/runtime';
//   import type { Page } from 'playwright-core';
//
//   test('run workflow', async ({ page }) => {
//     await workflow('wf_my_task', async (sfPage) => { ... });
//     // or: run the workflow with a Playwright page:
//     const fn = getWorkflow('wf_my_task');
//     await fn?.(asPage(page));
//   });

import type { Page as PlaywrightPage, Locator as PlaywrightLocator } from 'playwright-core';
import type { Page, Locator } from '@asc/runtime';

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
