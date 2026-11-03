// @sfysh/parser lifts hand-written Playwright TypeScript scripts into the
// Starfysh IR, so existing scripts can be verified and healed by the same
// toolchain that handles agent-authored workflows.
//
// Status: scaffold only. The ts-morph AST walker, selector extraction, and
// pre/post condition inference land as follow-up items under Phase 1 in
// docs/planning/ToDo.md. Importing parse() today throws.

import type { Workflow } from '@sfysh/ir';

export class ParserNotImplementedError extends Error {
  constructor() {
    super(
      '@sfysh/parser is scaffolded but not yet implemented. See Phase 1 in docs/planning/ToDo.md.',
    );
    this.name = 'ParserNotImplementedError';
  }
}

/**
 * Parse a Playwright TypeScript source string into a Starfysh workflow IR.
 *
 * Not yet implemented. The signature is fixed so dependents can be written
 * against it; the body throws until the real walker lands.
 */
export function parse(_source: string): Workflow {
  throw new ParserNotImplementedError();
}
