// Conditional step wrapper.
//
// Generated code calls:
//   await guard(page.getByRole('button', { name: 'Accept' }), (btn) => btn.click());
// to run a step only if the element is present. Absence is not a failure.

import type { Locator } from './types.js';

/**
 * Run `callback(locator)` only if the locator resolves to a visible element.
 * Returns the callback's result on success, undefined if the guard did not fire.
 *
 * Visibility is checked via Locator.isVisible with a short timeout; any error
 * from the visibility check (locator not found, timeout) is treated as "not
 * visible" rather than propagating. This mirrors the "cookie banner may or
 * may not appear" pattern that guards are designed for.
 */
export async function guard<T>(
  locator: Locator,
  callback: (locator: Locator) => Promise<T>,
): Promise<T | undefined> {
  const visible = await locator.isVisible().catch(() => false);
  if (!visible) return undefined;
  return callback(locator);
}
