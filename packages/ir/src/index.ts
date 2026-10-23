// @asc/ir — the typed intermediate representation at the centre of the compiler.
// Every other package depends on this one. Nothing in this package depends
// on anything else in the workspace.

export * from './types.js';
export * from './validate.js';

/**
 * Semantic version of the IR schema this package publishes.
 * A workflow's `irVersion` field must match this at parse time, unless a
 * migration path is defined.
 */
export const IR_VERSION = '1.0.0';
