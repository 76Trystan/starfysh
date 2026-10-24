// Starfysh's own browser automation interfaces.
//
// These are the types generated workflow scripts depend on. They are
// intentionally a named subset of Playwright's Page and Locator APIs so
// that a Playwright page satisfies them structurally -- but the dependency
// on Playwright is in @asc/playwright-adapter, not here.

/**
 * A handle to a single DOM element (or a collection of elements). Returned
 * by all Page locator methods and used by emit, guard, and generated code.
 */
export interface Locator {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  isVisible(): Promise<boolean>;
  locator(selector: string): Locator;
  count(): Promise<number>;
  nth(i: number): Locator;
  allTextContents(): Promise<string[]>;
  all(): Promise<Locator[]>;
}

/**
 * A single browser page. Generated workflow scripts receive this as their
 * first argument. Any browser backend that implements this interface can
 * run a Starfysh workflow -- see @asc/playwright-adapter for the reference
 * implementation.
 */
export interface Page {
  goto(url: string, options?: { waitUntil?: string }): Promise<void>;
  url(): string;
  locator(selector: string): Locator;
  getByRole(role: string, options?: Record<string, unknown>): Locator;
  getByTestId(value: string): Locator;
  getByText(value: string): Locator;
  getByLabel(value: string): Locator;
  waitForTimeout(millis: number): Promise<void>;
}
