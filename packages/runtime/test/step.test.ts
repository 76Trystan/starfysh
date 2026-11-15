// Step attribution and page snapshot capture on failed runs.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  assertCondition,
  capturePageSnapshot,
  createWorkflowContext,
  describeFailure,
  ExtractionError,
  PostconditionViolation,
  resetWorkflows,
  run,
  step,
  StepFailure,
  workflow,
} from '../src/index.js';
import type { Locator, Page, WorkflowContext } from '../src/index.js';

const stubLocator: Locator = {
  click: async () => {},
  fill: async () => {},
  isVisible: async () => false,
  locator: () => stubLocator,
  count: async () => 0,
  nth: () => stubLocator,
  allTextContents: async () => [],
  all: async () => [],
};

function stubPage(overrides: Partial<Page> = {}): Page {
  return {
    goto: async () => {},
    url: () => 'https://example.com/login',
    locator: () => stubLocator,
    getByRole: () => stubLocator,
    getByTestId: () => stubLocator,
    getByText: () => stubLocator,
    getByLabel: () => stubLocator,
    waitForTimeout: async () => {},
    ...overrides,
  };
}

function newCtx(page: Page = stubPage(), secret?: string): WorkflowContext {
  return createWorkflowContext({
    page,
    ...(secret !== undefined ? { vaultResolver: { resolve: () => secret } } : {}),
  });
}

const clickInfo = {
  id: 'click_003',
  action: 'click',
  selector: { kind: 'role' as const, value: "button[name='Sign in']" },
};

describe('step()', () => {
  it('returns the value of the body', async () => {
    await expect(step(newCtx(), clickInfo, async () => 42)).resolves.toBe(42);
  });

  it('wraps a thrown error in a StepFailure that names the step', async () => {
    const original = new Error('locator.click: Timeout 30000ms exceeded.');
    const thrown = await step(newCtx(), clickInfo, async () => {
      throw original;
    }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(StepFailure);
    const failure = thrown as StepFailure;
    expect(failure.step).toEqual(clickInfo);
    expect(failure.cause).toBe(original);
    expect(failure.message).toBe(original.message);
  });

  it('keeps the innermost step when steps are nested', async () => {
    const ctx = newCtx();
    const thrown = await step(ctx, { id: 'loop_001', action: 'loop' }, async () => {
      await step(ctx, { id: 'guard_002', action: 'guard' }, async () => {
        await step(ctx, clickInfo, async () => {
          throw new Error('inner broke');
        });
      });
    }).catch((e: unknown) => e);

    expect((thrown as StepFailure).step.id).toBe('click_003');
  });

  it('attributes a failure in the outer body to the outer step', async () => {
    const ctx = newCtx();
    const thrown = await step(ctx, { id: 'guard_002', action: 'guard' }, async () => {
      await step(ctx, clickInfo, async () => {});
      throw new Error('guard condition could not be evaluated');
    }).catch((e: unknown) => e);

    expect((thrown as StepFailure).step.id).toBe('guard_002');
  });

  it('wraps non-Error throws too', async () => {
    const thrown = await step(newCtx(), clickInfo, async () => {
      throw 'a string';
    }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(StepFailure);
    expect((thrown as StepFailure).cause).toBe('a string');
    expect((thrown as StepFailure).message).toBe('a string');
  });
});

describe('describeFailure()', () => {
  it('unwraps a StepFailure and reports step, action and selector', () => {
    const original = new ExtractionError("Column 'qty' not found");
    const described = describeFailure(newCtx(), new StepFailure(clickInfo, original));

    expect(described.cause).toBe(original);
    expect(described.name).toBe('ExtractionError');
    expect(described.message).toBe("[click_003] Column 'qty' not found");
    expect(described.attribution).toEqual({
      stepId: 'click_003',
      action: 'click',
      selector: { kind: 'role', value: "button[name='Sign in']" },
    });
  });

  it('adds phase, condition and reason for a violated condition', () => {
    const violation = new PostconditionViolation({
      stepId: 'click_003',
      phase: 'post',
      condition: { urlMatches: '/dashboard' },
      reason: "URL 'https://example.com/login' did not match '/dashboard'",
    });
    const described = describeFailure(newCtx(), new StepFailure(clickInfo, violation));

    expect(described.cause).toBe(violation);
    expect(described.name).toBe('PostconditionViolation');
    // The violation message already names the step; it is not prefixed twice.
    expect(described.message).toBe(violation.message);
    expect(described.attribution).toEqual({
      stepId: 'click_003',
      action: 'click',
      selector: { kind: 'role', value: "button[name='Sign in']" },
      phase: 'post',
      condition: { urlMatches: '/dashboard' },
      reason: "URL 'https://example.com/login' did not match '/dashboard'",
    });
  });

  it('reports a bare PostconditionViolation from a hand-written workflow', () => {
    const violation = new PostconditionViolation({
      stepId: 'manual_step',
      phase: 'pre',
      condition: { selectorVisible: '#form' },
      reason: "Selector '#form' not visible",
    });
    const described = describeFailure(newCtx(), violation);
    expect(described.attribution).toEqual({
      stepId: 'manual_step',
      phase: 'pre',
      condition: { selectorVisible: '#form' },
      reason: "Selector '#form' not visible",
    });
  });

  it('leaves attribution empty for an error thrown outside any step', () => {
    const described = describeFailure(newCtx(), new Error('boom'));
    expect(described.attribution).toEqual({});
    expect(described.message).toBe('boom');
    expect(described.name).toBe('Error');
  });

  it('redacts secrets from the message, selector, condition and reason', () => {
    const ctx = newCtx(stubPage(), 'hunter2-secret');
    ctx.vault('portal_pass');
    const violation = new PostconditionViolation({
      stepId: 'fill_002',
      phase: 'post',
      condition: { textPresent: 'hunter2-secret' },
      reason: "Text 'hunter2-secret' not present",
    });
    const described = describeFailure(
      ctx,
      new StepFailure(
        {
          id: 'fill_002',
          action: 'fill',
          selector: { kind: 'css', value: 'input[value="hunter2-secret"]' },
        },
        violation,
      ),
    );

    expect(JSON.stringify(described.attribution)).not.toContain('hunter2-secret');
    expect(described.message).not.toContain('hunter2-secret');
    expect(described.attribution.selector?.value).toBe('input[value="[REDACTED:portal_pass]"]');
    expect(described.attribution.condition).toEqual({ textPresent: '[REDACTED:portal_pass]' });
    // The raw cause is untouched; it is for triage and never serialised.
    expect(described.cause).toBe(violation);
  });
});

describe('run(): failure attribution', () => {
  beforeEach(() => {
    resetWorkflows();
  });

  it('attributes a failed action to its step, not only failed conditions', async () => {
    const page = stubPage({
      getByRole: () => ({
        ...stubLocator,
        click: async () => {
          const err = new Error('locator.click: Timeout 30000ms exceeded.');
          err.name = 'TimeoutError';
          throw err;
        },
      }),
    });
    workflow('wf-action-fails', async (ctx) => {
      await step(ctx, { id: 'nav_001', action: 'navigate' }, async () => {
        await ctx.page.goto('https://example.com/login');
      });
      await step(ctx, clickInfo, async () => {
        await ctx.page.getByRole('button', { name: 'Sign in' }).click();
      });
    });

    const result = await run('wf-action-fails', newCtx(page));

    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({
      name: 'TimeoutError',
      message: '[click_003] locator.click: Timeout 30000ms exceeded.',
      stepId: 'click_003',
      action: 'click',
      selector: { kind: 'role', value: "button[name='Sign in']" },
    });
    expect(result.error?.phase).toBeUndefined();
    // The cause is the original error, so triage instanceof checks still work.
    expect(result.error?.cause).toBeInstanceOf(Error);
    expect(result.error?.cause).not.toBeInstanceOf(StepFailure);
  });

  it('carries the violated condition and reason for a post failure', async () => {
    workflow('wf-post-fails', async (ctx) => {
      await step(ctx, clickInfo, async () => {
        await assertCondition(ctx, 'click_003', 'post', { urlMatches: '/dashboard' });
      });
    });

    const result = await run('wf-post-fails', newCtx());

    expect(result.error).toMatchObject({
      name: 'PostconditionViolation',
      stepId: 'click_003',
      action: 'click',
      phase: 'post',
      condition: { urlMatches: '/dashboard' },
      reason: "URL 'https://example.com/login' did not match '/dashboard'",
    });
    expect(result.error?.cause).toBeInstanceOf(PostconditionViolation);
  });

  it('serialises the attribution but not the raw cause', async () => {
    workflow('wf-serialise', async (ctx) => {
      await step(ctx, clickInfo, async () => {
        throw new Error('nope');
      });
    });
    const result = await run('wf-serialise', newCtx());
    const parsed = JSON.parse(JSON.stringify(result)) as { error: Record<string, unknown> };
    expect(parsed.error).toEqual({
      name: 'Error',
      message: '[click_003] nope',
      stepId: 'click_003',
      action: 'click',
      selector: { kind: 'role', value: "button[name='Sign in']" },
    });
  });
});

describe('page snapshot on failure', () => {
  beforeEach(() => {
    resetWorkflows();
    workflow('wf-fails', async () => {
      throw new Error('broken');
    });
    workflow('wf-ok', async () => {});
  });

  it('attaches a snapshot to a failed run when the page supports it', async () => {
    const page = stubPage({ snapshot: async () => '- heading "Sign in" [level=1]' });
    const result = await run('wf-fails', newCtx(page));
    expect(result.snapshot).toEqual({
      text: '- heading "Sign in" [level=1]',
      truncated: false,
      originalLength: 29,
    });
  });

  it('does not take a snapshot of a successful run', async () => {
    let calls = 0;
    const page = stubPage({
      snapshot: async () => {
        calls++;
        return 'x';
      },
    });
    const result = await run('wf-ok', newCtx(page));
    expect(result.snapshot).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('omits the snapshot when the backend has no snapshot method', async () => {
    const result = await run('wf-fails', newCtx(stubPage()));
    expect(result.status).toBe('failed');
    expect(result.snapshot).toBeUndefined();
  });

  it('omits the snapshot, and keeps the original failure, when capture throws', async () => {
    const page = stubPage({
      snapshot: async () => {
        throw new Error('Target page, context or browser has been closed');
      },
    });
    const result = await run('wf-fails', newCtx(page));
    expect(result.error?.message).toBe('broken');
    expect(result.snapshot).toBeUndefined();
  });

  it('gives up when the page does not answer within the timeout', async () => {
    const page = stubPage({ snapshot: () => new Promise<string>(() => {}) });
    const started = Date.now();
    const result = await run('wf-fails', newCtx(page), { snapshot: { timeoutMs: 20 } });
    expect(result.snapshot).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('caps the snapshot length and records that it was cut', async () => {
    const page = stubPage({ snapshot: async () => 'abcdefghij'.repeat(10) });
    const result = await run('wf-fails', newCtx(page), { snapshot: { maxChars: 25 } });
    expect(result.snapshot).toEqual({
      text: 'abcdefghijabcdefghijabcde',
      truncated: true,
      originalLength: 100,
    });
  });

  it('redacts secrets before cutting, so no fragment survives at the cap', async () => {
    const page = stubPage({ snapshot: async () => 'value: hunter2-secret and more text' });
    const ctx = newCtx(page, 'hunter2-secret');
    ctx.vault('portal_pass');
    // A cap of 12 would cut the raw text in the middle of the secret.
    const snapshot = await capturePageSnapshot(ctx, { maxChars: 12 });
    expect(snapshot?.text).toBe('value: [REDA');
    expect(snapshot?.text).not.toContain('hunt');
  });

  it('skips capture when asked to', async () => {
    let calls = 0;
    const page = stubPage({
      snapshot: async () => {
        calls++;
        return 'x';
      },
    });
    const result = await run('wf-fails', newCtx(page), { snapshot: false });
    expect(result.snapshot).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('ignores a backend that returns something other than a string', async () => {
    const page = stubPage({
      snapshot: (async () => ({ tree: [] })) as unknown as () => Promise<string>,
    });
    const result = await run('wf-fails', newCtx(page));
    expect(result.snapshot).toBeUndefined();
  });
});
