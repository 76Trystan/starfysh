export {
  buildHealPrompt,
  HealInputError,
  HEAL_SYSTEM_PROMPT,
  DEFAULT_PROMPT_SNAPSHOT_MAX_CHARS,
  PROMPT_ERROR_MAX_CHARS,
  PROMPT_OUTLINE_MAX_STEPS,
} from './prompt.js';
export type {
  HealFailure,
  HealInputErrorCode,
  HealPrompt,
  HealPromptInput,
  HealTriage,
} from './prompt.js';

export { parseHealResponse, RATIONALE_MAX_CHARS, RESPONSE_MAX_CHARS } from './response.js';
export type { HealPatchContext, HealResponse, HealResponseErrorCode } from './response.js';

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
