export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

/**
 * Assert that a condition is true. Throws AssertionError if not.
 * Used by generated assert steps in place of a test-framework expect().
 */
export function assert(condition: boolean, message?: string): void {
  if (!condition) throw new AssertionError(message ?? 'Workflow assertion failed.');
}

/**
 * Poll until a condition returns true or the timeout is reached.
 * Used by generated wait steps that depend on page state.
 */
export async function poll(
  fn: () => Promise<boolean> | boolean,
  options: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const timeout = options.timeout ?? 30_000;
  const interval = options.interval ?? 250;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new AssertionError('poll() timed out waiting for condition to become true.');
}
