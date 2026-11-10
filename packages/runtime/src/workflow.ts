import type { WorkflowContext } from './context.js';

/**
 * Signature of a registered workflow function. Defaults to the Phase 1
 * browser context; Phase 2 instantiates the same registry under a wider
 * context type that adds `http: HttpClient`.
 */
export type WorkflowFn<TCtx = WorkflowContext> = (ctx: TCtx) => Promise<void>;

const registry = new Map<string, WorkflowFn<unknown>>();

/**
 * Thrown when `workflow(id, fn)` is called with an id that is already
 * registered. Silent overwrite is a surprising failure mode once replay
 * loops and healer-driven re-registration become common, so collisions
 * fail loudly.
 */
export class WorkflowIdCollisionError extends Error {
  public readonly workflowId: string;

  constructor(id: string) {
    super(
      `Workflow id "${id}" is already registered. Each id must be unique within a process; ` +
        `call resetWorkflows() between test cases if you need to re-register.`,
    );
    this.name = 'WorkflowIdCollisionError';
    this.workflowId = id;
  }
}

/**
 * Register a named workflow. The Starfysh runner calls this function's
 * registered callback with a WorkflowContext when executing the workflow.
 * Throws WorkflowIdCollisionError if `id` is already registered.
 *
 * Generated code always calls workflow() as its top-level wrapper.
 */
export function workflow<TCtx = WorkflowContext>(id: string, fn: WorkflowFn<TCtx>): void {
  if (registry.has(id)) throw new WorkflowIdCollisionError(id);
  registry.set(id, fn as WorkflowFn<unknown>);
}

export function getWorkflow<TCtx = WorkflowContext>(id: string): WorkflowFn<TCtx> | undefined {
  return registry.get(id) as WorkflowFn<TCtx> | undefined;
}

export function listWorkflows(): string[] {
  return Array.from(registry.keys());
}

/**
 * Clear every registered workflow. Test helper; production runners never
 * call this. The registry is a module singleton today, so tests that
 * register the same id across cases need to drain it between runs.
 */
export function resetWorkflows(): void {
  registry.clear();
}
