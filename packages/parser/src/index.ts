import type { Workflow, Step } from '@sfysh/ir';
import { IR_VERSION } from '@sfysh/ir';
import { walkFile } from './walker.js';
import { chainsToSteps } from './steps.js';

export { walkFile } from './walker.js';
export type { WalkedTest, CallChain, ChainLink, SourcePos } from './walker.js';

export { extractCandidate, extractTarget, isLocatorLink, unquote } from './selectors.js';

export { extractCondition } from './conditions.js';

export { chainsToSteps } from './steps.js';

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/**
 * Parse a Playwright TypeScript source string into a Starfysh workflow IR.
 *
 * Extracts the first `test()` call, maps its Playwright actions (goto, click,
 * fill, waitFor*) to IR steps, and converts `expect()` assertions into
 * postconditions on the preceding step or standalone assert steps.
 */
export function parse(source: string): Workflow {
  const tests = walkFile(source);
  if (tests.length === 0) {
    throw new ParseError('No test() calls found in source');
  }

  const test = tests[0]!;
  const steps = chainsToSteps(test.calls);

  if (steps.length === 0) {
    throw new ParseError(`No recognizable Playwright actions found in test '${test.name}'`);
  }

  return {
    irVersion: IR_VERSION,
    id: slugify(test.name),
    name: test.name,
    steps: steps as [Step, ...Step[]],
    metadata: { source: 'parser' },
  };
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
