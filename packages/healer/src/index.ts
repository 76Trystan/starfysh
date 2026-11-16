/**
 * Thrown by `heal()` until the healer is implemented. The package is a
 * scaffold: it exists so the workspace wiring, the dependency graph and the
 * test runner are in place before any healing logic lands.
 */
export class HealerNotImplementedError extends Error {
  constructor() {
    super('@sfysh/healer is a scaffold. heal() is not implemented yet.');
    this.name = 'HealerNotImplementedError';
  }
}

/**
 * Placeholder entry point. The real signature is settled when the model
 * input builder and the patch parser land, so this takes no arguments
 * instead of committing to a shape early.
 */
export async function heal(): Promise<never> {
  throw new HealerNotImplementedError();
}
