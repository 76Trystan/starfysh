// Starfysh's own browser automation interfaces.
//
// These are the types generated workflow scripts depend on. They are
// intentionally a named subset of Playwright's Page and Locator APIs so
// that a Playwright page satisfies them structurally -- but the dependency
// on Playwright is in @sfysh/playwright-adapter, not here.

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
  /**
   * The same lookups a `Page` has, scoped to this element. Generated code
   * uses them inside a `foreach` loop, where every target is looked up
   * within the current item rather than across the whole page.
   */
  getByRole(role: string, options?: Record<string, unknown>): Locator;
  getByTestId(value: string): Locator;
  getByText(value: string): Locator;
  getByLabel(value: string): Locator;
}

/**
 * A single browser page. Generated workflow scripts receive this as their
 * first argument. Any browser backend that implements this interface can
 * run a Starfysh workflow -- see @sfysh/playwright-adapter for the reference
 * implementation.
 */
export interface Page {
  goto(
    url: string,
    options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' },
  ): Promise<void>;
  url(): string;
  locator(selector: string): Locator;
  getByRole(role: string, options?: Record<string, unknown>): Locator;
  getByTestId(value: string): Locator;
  getByText(value: string): Locator;
  getByLabel(value: string): Locator;
  waitForTimeout(millis: number): Promise<void>;
  /**
   * Return the page's accessibility tree as text. Optional: a backend that
   * cannot produce one leaves it out, and failed runs then carry no
   * snapshot. The runtime calls this only after a failure, to record what
   * the page looked like. The result is untrusted page content.
   */
  snapshot?(): Promise<string>;
}
