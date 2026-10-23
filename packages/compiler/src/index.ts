// @asc/compiler, emits Playwright TypeScript from a validated IR workflow.
//
// Public surface:
//   compile(workflow)        - takes a validated Workflow, returns formatted source
//   compileUnknown(data)     - validates then compiles unknown JSON
//   createTemplater()        - advanced: build your own templater instance
//   formatTypeScript(src)    - advanced: format a hand-written string with the
//                              compiler's pinned Prettier config
//
// Determinism contract: for any valid Workflow, compile(workflow) returns the
// same source byte-for-byte on every call. The determinism test enforces this.

export { compile, compileUnknown, type CompileResult } from './compile.js';
export { createTemplater, CompilerError, Templater } from './templater.js';
export { formatTypeScript } from './format.js';

export const COMPILER_VERSION = '0.0.0';
