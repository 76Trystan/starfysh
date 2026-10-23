// Main compile entry point. Validates the workflow, renders it via the
// templater, formats the result with Prettier, and returns the generated
// TypeScript source as a string.

import { validateWorkflow, type Workflow } from '@asc/ir';
import { createTemplater, CompilerError } from './templater.js';
import { formatTypeScript } from './format.js';

export interface CompileResult {
  /** The generated Playwright TypeScript source, formatted. */
  source: string;
  /** The workflow id, echoed for convenience. */
  workflowId: string;
}

/**
 * Compile a validated Workflow into Playwright TypeScript.
 * Validates the input first; invalid workflows throw CompilerError before
 * any codegen happens.
 */
export async function compile(workflow: Workflow): Promise<CompileResult> {
  const check = validateWorkflow(workflow);
  if (!check.valid) {
    const details = check.errors
      .slice(0, 5)
      .map((e) => `  ${e.path}: ${e.message}`)
      .join('\n');
    throw new CompilerError(
      `Workflow failed validation (${check.errors.length} error${check.errors.length === 1 ? '' : 's'}):\n${details}`,
    );
  }

  const templater = createTemplater();
  const unformatted = templater.renderWorkflow(workflow);
  const source = await formatTypeScript(unformatted);
  return { source, workflowId: workflow.id };
}

/**
 * Compile an unknown value as a Workflow. Convenience wrapper for CLI
 * usage that reads a JSON file and does not yet know whether it is valid.
 */
export async function compileUnknown(data: unknown): Promise<CompileResult> {
  const check = validateWorkflow(data);
  if (!check.valid) {
    const details = check.errors
      .slice(0, 5)
      .map((e) => `  ${e.path}: ${e.message}`)
      .join('\n');
    throw new CompilerError(
      `Input failed validation (${check.errors.length} error${check.errors.length === 1 ? '' : 's'}):\n${details}`,
    );
  }
  return compile(check.value!);
}
