import { describe, it, expect, beforeEach } from 'vitest';
import {
  workflow,
  getWorkflow,
  listWorkflows,
  resetWorkflows,
  WorkflowIdCollisionError,
} from '../src/index.js';

describe('workflow registry', () => {
  beforeEach(() => {
    resetWorkflows();
  });

  it('registers and retrieves a workflow by id', () => {
    const fn = async () => {};
    workflow('reg-one', fn);
    expect(getWorkflow('reg-one')).toBe(fn);
  });

  it('listWorkflows returns every registered id', () => {
    workflow('reg-a', async () => {});
    workflow('reg-b', async () => {});
    expect(listWorkflows().sort()).toEqual(['reg-a', 'reg-b']);
  });

  it('throws WorkflowIdCollisionError on duplicate registration', () => {
    workflow('reg-dup', async () => {});
    expect(() => workflow('reg-dup', async () => {})).toThrow(WorkflowIdCollisionError);
  });

  it('collision error carries the offending id', () => {
    workflow('reg-named', async () => {});
    try {
      workflow('reg-named', async () => {});
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowIdCollisionError);
      expect((err as WorkflowIdCollisionError).workflowId).toBe('reg-named');
    }
  });

  it('resetWorkflows clears every registration', () => {
    workflow('reg-clear-a', async () => {});
    workflow('reg-clear-b', async () => {});
    resetWorkflows();
    expect(listWorkflows()).toEqual([]);
    expect(getWorkflow('reg-clear-a')).toBeUndefined();
  });

  it('resetWorkflows allows re-registering the same id afterwards', () => {
    workflow('reg-recycle', async () => {});
    resetWorkflows();
    expect(() => workflow('reg-recycle', async () => {})).not.toThrow();
  });
});
