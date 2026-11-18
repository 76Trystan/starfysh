import { beforeEach, describe, expect, it } from 'vitest';
import {
  createWorkflowContext,
  resetWorkflows,
  run,
  step,
  StepFailure,
  tryCandidates,
  workflow,
} from '../src/index.js';
import type { CandidateLookup, Locator, Page, StepInfo, WorkflowContext } from '../src/index.js';

const page = {} as Page;

function ctx(secret?: string): WorkflowContext {
  return createWorkflowContext({
    page,
    vaultResolver: { resolve: () => secret },
  });
}

/** A candidate whose locator records the action and fails if told to. */
function lookup(index: number, value: string, calls: string[], fails = false): CandidateLookup {
  return {
    index,
    selector: { kind: 'css', value },
    locate: () =>
      ({
        click: async () => {
          calls.push(value);
          if (fails) throw new Error(`no element ${value}`);
        },
      }) as unknown as Locator,
  };
}

const click = (l: Locator) => l.click();

describe('tryCandidates', () => {
  it('stops at the primary when it works, and records nothing', async () => {
    const c = ctx();
    const calls: string[] = [];
    const info: StepInfo = { id: 'click_001', action: 'click' };
    await tryCandidates(c, info, [lookup(0, '#a', calls), lookup(1, '#b', calls)], click);
    expect(calls).toEqual(['#a']);
    expect(info).toMatchObject({ selector: { value: '#a' }, candidateIndex: 0 });
    expect(c.degraded()).toEqual([]);
  });

  it('falls through in rank order and records the step as degraded', async () => {
    const c = ctx();
    const calls: string[] = [];
    const info: StepInfo = { id: 'click_001', action: 'click' };
    await tryCandidates(
      c,
      info,
      [lookup(0, '#a', calls, true), lookup(1, '#b', calls, true), lookup(3, '#d', calls)],
      click,
    );
    expect(calls).toEqual(['#a', '#b', '#d']);
    expect(info).toMatchObject({ selector: { value: '#d' }, candidateIndex: 3 });
    expect(c.degraded()).toEqual([
      { stepId: 'click_001', candidateIndex: 3, selector: { kind: 'css', value: '#d' } },
    ]);
  });

  it("throws the primary's error and puts attribution back on the primary when all fail", async () => {
    const c = ctx();
    const calls: string[] = [];
    const info: StepInfo = { id: 'click_001', action: 'click' };
    await expect(
      tryCandidates(c, info, [lookup(0, '#a', calls, true), lookup(1, '#b', calls, true)], click),
    ).rejects.toThrow('no element #a');
    expect(info).toMatchObject({ selector: { value: '#a' }, candidateIndex: 0 });
    expect(c.degraded()).toEqual([]);
  });

  it('refuses an empty candidate list', async () => {
    await expect(tryCandidates(ctx(), { id: 's', action: 'click' }, [], click)).rejects.toThrow(
      /no selector candidates/,
    );
  });

  it('attributes a failure inside step() to the candidate in use', async () => {
    const c = ctx();
    const calls: string[] = [];
    const thrown = await step(c, { id: 'click_001', action: 'click' }, (info) =>
      tryCandidates(c, info, [lookup(0, '#a', calls, true), lookup(1, '#b', calls, true)], click),
    ).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(StepFailure);
    expect((thrown as StepFailure).step).toMatchObject({
      selector: { value: '#a' },
      candidateIndex: 0,
    });
  });

  it('redacts selector values when the degraded steps are read', async () => {
    const c = ctx('s3cr3t-value');
    c.vault('token');
    c.recordDegraded({
      stepId: 'click_001',
      candidateIndex: 1,
      selector: { kind: 'css', value: '[data-token="s3cr3t-value"]' },
    });
    expect(c.degraded()[0]!.selector.value).toBe('[data-token="[REDACTED:token]"]');
  });
});

describe('run() reports degraded steps', () => {
  beforeEach(() => resetWorkflows());

  it('on a passing run, and leaves the field off when nothing degraded', async () => {
    const calls: string[] = [];
    workflow('wf_degraded', async (c) => {
      await step(c, { id: 'click_001', action: 'click' }, (info) =>
        tryCandidates(c, info, [lookup(0, '#a', calls, true), lookup(1, '#b', calls)], click),
      );
    });
    workflow('wf_clean', async (c) => {
      await step(c, { id: 'click_001', action: 'click' }, (info) =>
        tryCandidates(c, info, [lookup(0, '#a', calls), lookup(1, '#b', calls)], click),
      );
    });

    const degraded = await run('wf_degraded', ctx());
    expect(degraded.status).toBe('ok');
    expect(degraded.degraded).toEqual([
      { stepId: 'click_001', candidateIndex: 1, selector: { kind: 'css', value: '#b' } },
    ]);
    const clean = await run('wf_clean', ctx());
    expect(clean).not.toHaveProperty('degraded');
  });

  it('on a failed run, with the candidate index in the error', async () => {
    const calls: string[] = [];
    workflow('wf_fails', async (c) => {
      await step(c, { id: 'click_001', action: 'click' }, (info) =>
        tryCandidates(c, info, [lookup(0, '#a', calls), lookup(1, '#b', calls)], click),
      );
      await step(c, { id: 'click_002', action: 'click' }, (info) =>
        tryCandidates(c, info, [lookup(0, '#c', calls, true), lookup(1, '#d', calls, true)], click),
      );
    });
    const result = await run('wf_fails', ctx(), { snapshot: false });
    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({
      stepId: 'click_002',
      candidateIndex: 0,
      selector: { kind: 'css', value: '#c' },
    });
  });
});
