import type { Page } from './types.js';

/**
 * Signature of a registered workflow function. Parameterised over context
 * type so Phase 2 can register workflows against a different shape (e.g.
 * `{ page: Page; http: HttpClient }`) without breaking the browser default.
 * All current callers resolve to `WorkflowFn<Page>` implicitly.
 */
export type WorkflowFn<TCtx = Page> = (ctx: TCtx) => Promise<void>;

const registry = new Map<string, WorkflowFn<unknown>>();

/**
 * Register a named workflow. The Starfysh runner calls this function's
 * registered callback with the appropriate context when executing the
 * workflow. Defaults to a browser Page; callers specify a different
 * context type via the TCtx type parameter.
 *
 * Generated code always calls workflow() as its top-level wrapper.
 */
export function workflow<TCtx = Page>(id: string, fn: WorkflowFn<TCtx>): void {
  registry.set(id, fn as WorkflowFn<unknown>);
}

export function getWorkflow<TCtx = Page>(id: string): WorkflowFn<TCtx> | undefined {
  return registry.get(id) as WorkflowFn<TCtx> | undefined;
}

export function listWorkflows(): string[] {
  return Array.from(registry.keys());
}
