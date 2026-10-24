import type { Page } from './types.js';

export type WorkflowFn = (page: Page) => Promise<void>;

const registry = new Map<string, WorkflowFn>();

/**
 * Register a named workflow. The Starfysh runner calls this function's
 * registered callback with a Page implementation when executing the workflow.
 *
 * Generated code always calls workflow() as its top-level wrapper.
 */
export function workflow(id: string, fn: WorkflowFn): void {
  registry.set(id, fn);
}

export function getWorkflow(id: string): WorkflowFn | undefined {
  return registry.get(id);
}

export function listWorkflows(): string[] {
  return Array.from(registry.keys());
}
