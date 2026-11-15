import type { Workflow, Step } from '@sfysh/ir';
import { IR_VERSION } from '@sfysh/ir';
import { walkFile } from './walker.js';
import { chainsToSteps } from './steps.js';
import type { UnsupportedCall } from './steps.js';

export { walkFile } from './walker.js';
export type {
  WalkedTest,
  WalkerItem,
  CallChain,
  ForOfLoop,
  ChainLink,
  SourcePos,
} from './walker.js';

export { extractCandidate, extractTarget, isLocatorLink, unquote } from './selectors.js';

export { extractCondition } from './conditions.js';

export { chainsToSteps } from './steps.js';
export type { UnsupportedCall, ChainsToStepsResult } from './steps.js';

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/**
 * Outcome of `parse()`. The workflow is the IR that downstream consumers
 * (compiler, verifier, CLI) use. `unsupported` is a non-throwing report of
 * every call the parser recognised syntactically but could not map into the
 * IR: `page.<method>` chains with an unsupported terminal method, and
 * `expect()` chains whose matcher (or subject, or argument) the condition
 * extractor could not translate. Callers should surface it so users know
 * which actions and assertions were dropped from the workflow.
 */
export interface ParseResult {
  workflow: Workflow;
  unsupported: UnsupportedCall[];
}

/**
 * Parse a Playwright TypeScript source string into a Starfysh workflow IR.
 *
 * Extracts the first `test()` call, maps its Playwright actions (goto, click,
 * fill, waitFor*) to IR steps, and converts `expect()` assertions into
 * postconditions on the preceding step or standalone assert steps. Any
 * `page.<method>()` call whose terminal method is outside the supported set,
 * and any `expect()` assertion that cannot be mapped to an IR Condition, is
 * collected into `unsupported` rather than dropped silently.
 */
export function parse(source: string): ParseResult {
  const tests = walkFile(source);
  if (tests.length === 0) {
    throw new ParseError('No test() calls found in source');
  }

  const test = tests[0]!;
  const { steps, unsupported } = chainsToSteps(test.calls);

  if (steps.length === 0) {
    throw new ParseError(`No recognizable Playwright actions found in test '${test.name}'`);
  }

  const workflow: Workflow = {
    irVersion: IR_VERSION,
    id: slugify(test.name),
    name: test.name,
    steps: steps as [Step, ...Step[]],
    metadata: { source: 'parser' },
  };

  return { workflow, unsupported };
}

function slugify(name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!slug || !/^[a-z]/.test(slug)) slug = `wf_${slug}`;
  if (slug.length < 3) slug = `wf_${slug}`;

  return slug.slice(0, 64);
}
