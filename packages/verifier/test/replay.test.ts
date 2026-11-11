import { describe, it, expect } from 'vitest';
import type { Workflow } from '@sfysh/ir';
import { IR_VERSION } from '@sfysh/ir';
import type { Page, Locator } from '@sfysh/runtime';
import { PostconditionViolation } from '@sfysh/runtime';
import { replay } from '../src/replay.js';

function stubLocator(overrides: Partial<Locator> = {}): Locator {
  const base: Locator = {
    click: async () => {},
    fill: async () => {},
    isVisible: async () => true,
    locator: () => stubLocator(overrides),
    count: async () => 1,
    nth: () => stubLocator(overrides),
    allTextContents: async () => [],
    all: async () => [],
  };
  return { ...base, ...overrides };
}

function stubPage(overrides: Partial<Page> = {}): Page {
  const base: Page = {
    goto: async () => {},
    url: () => 'https://example.com/done',
    locator: () => stubLocator(),
    getByRole: () => stubLocator(),
    getByTestId: () => stubLocator(),
    getByText: () => stubLocator(),
    getByLabel: () => stubLocator(),
    waitForTimeout: async () => {},
  };
  return { ...base, ...overrides };
}

function wf(post: Workflow['steps'][number]['post'] = []): Workflow {
  return {
    irVersion: IR_VERSION,
    id: 'test_wf',
    name: 'Test Workflow',
    steps: [
      {
        id: 'step_final',
        intent: 'final step',
        action: 'navigate',
        url: 'https://example.com',
        ...(post ? { post } : {}),
      },
    ],
  };
}

describe('replay', () => {
  it('runs the requested number of replays', async () => {
    let calls = 0;
    const report = await replay(wf(), {
      pageFactory: () => stubPage(),
      runner: async () => {
        calls++;
      },
      runs: 3,
    });
    expect(calls).toBe(3);
    expect(report.runs).toBe(3);
    expect(report.replays).toHaveLength(3);
  });

  it('defaults to three replays when runs is not set', async () => {
    const report = await replay(wf(), {
      pageFactory: () => stubPage(),
      runner: async () => {},
    });
    expect(report.runs).toBe(3);
  });

  it('clamps runs to at least one', async () => {
    const report = await replay(wf(), {
      pageFactory: () => stubPage(),
      runner: async () => {},
      runs: 0,
    });
    expect(report.runs).toBe(1);
  });

  it('counts passes and failures correctly when the runner throws', async () => {
    let n = 0;
    const report = await replay(wf(), {
      pageFactory: () => stubPage(),
      runner: async () => {
        n++;
        if (n === 2) throw new Error('boom');
      },
      runs: 3,
    });
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.replays[1]?.status).toBe('failed');
    expect(report.replays[1]?.error?.message).toBe('boom');
  });

  it('captures outputs emitted by the runner through ctx.emit', async () => {
    const report = await replay(wf(), {
      pageFactory: () => stubPage(),
      runner: async (ctx) => {
        ctx.emit.output({ ok: true });
      },
      runs: 2,
    });
    expect(report.replays.every((r) => r.outputs.length === 1)).toBe(true);
    expect(report.replays[0]?.outputs[0]).toEqual({ ok: true });
  });

  it('isolates outputs between replays via fresh contexts', async () => {
    let i = 0;
    const report = await replay(wf(), {
      pageFactory: () => stubPage(),
      runner: async (ctx) => {
        ctx.emit.output({ i: i++ });
      },
      runs: 3,
    });
    expect(report.replays.map((r) => r.outputs)).toEqual([[{ i: 0 }], [{ i: 1 }], [{ i: 2 }]]);
  });

  it('flags drift when outputs vary across replays', async () => {
    let i = 0;
    const report = await replay(wf(), {
      pageFactory: () => stubPage(),
      runner: async (ctx) => {
        ctx.emit.output({ value: i++ });
      },
      runs: 3,
    });
    expect(report.stability.stable).toBe(false);
    expect(report.stability.drift[0]?.path).toBe('0.value');
  });

  it('respects tolerance config', async () => {
    let i = 0;
    const report = await replay(wf(), {
      pageFactory: () => stubPage(),
      runner: async (ctx) => {
        ctx.emit.output({ timestamp: i++, value: 1 });
      },
      runs: 3,
      tolerance: { '0.timestamp': 'ignore' },
    });
    expect(report.stability.stable).toBe(true);
  });

  it('evaluates terminal postconditions against the page', async () => {
    const workflow = wf([{ urlMatches: '/done' }]);
    const report = await replay(workflow, {
      pageFactory: () => stubPage({ url: () => 'https://example.com/done' }),
      runner: async () => {},
      runs: 1,
    });
    expect(report.replays[0]?.postconditions).toHaveLength(1);
    expect(report.replays[0]?.postconditions[0]?.status).toBe('held');
    expect(report.replays[0]?.status).toBe('ok');
  });

  it('marks a replay failed when a terminal postcondition is violated', async () => {
    const workflow = wf([{ urlMatches: '/done' }]);
    const report = await replay(workflow, {
      pageFactory: () => stubPage({ url: () => 'https://example.com/elsewhere' }),
      runner: async () => {},
      runs: 1,
    });
    expect(report.replays[0]?.status).toBe('failed');
    expect(report.failed).toBe(1);
  });

  it('does not evaluate postconditions when the runner threw', async () => {
    const workflow = wf([{ urlMatches: '/done' }]);
    const report = await replay(workflow, {
      pageFactory: () => stubPage({ url: () => 'https://example.com/done' }),
      runner: async () => {
        throw new Error('runner failed');
      },
      runs: 1,
    });
    expect(report.replays[0]?.postconditions).toEqual([]);
    expect(report.replays[0]?.error?.message).toBe('runner failed');
  });

  it('records a timing envelope across replays', async () => {
    const report = await replay(wf(), {
      pageFactory: () => stubPage(),
      runner: async () => {
        await new Promise((r) => setTimeout(r, 5));
      },
      runs: 3,
    });
    expect(report.timing.samples).toHaveLength(3);
    expect(report.timing.minMs).toBeLessThanOrEqual(report.timing.meanMs);
    expect(report.timing.meanMs).toBeLessThanOrEqual(report.timing.maxMs);
  });

  it('invokes the disposer after each replay with the WorkflowContext', async () => {
    let disposed = 0;
    let lastDisposedPage: Page | undefined;
    await replay(wf(), {
      pageFactory: () => stubPage(),
      runner: async () => {},
      runs: 2,
      dispose: (ctx) => {
        disposed++;
        lastDisposedPage = ctx.page;
      },
    });
    expect(disposed).toBe(2);
    expect(lastDisposedPage).toBeDefined();
  });

  it('swallows disposer errors without failing the replay', async () => {
    const report = await replay(wf(), {
      pageFactory: () => stubPage(),
      runner: async () => {},
      runs: 1,
      dispose: () => {
        throw new Error('dispose blew up');
      },
    });
    expect(report.replays[0]?.status).toBe('ok');
  });

  it('surfaces stepId and phase when a PostconditionViolation escapes the runner (ADR 0011)', async () => {
    const report = await replay(wf(), {
      pageFactory: () => stubPage(),
      runner: async () => {
        throw new PostconditionViolation({
          stepId: 'step_submit_login',
          phase: 'pre',
          condition: { urlMatches: '/dashboard' },
          reason: "URL 'https://example.com/login' did not match '/dashboard'",
        });
      },
      runs: 1,
    });
    const err = report.replays[0]?.error;
    expect(err?.stepId).toBe('step_submit_login');
    expect(err?.phase).toBe('pre');
    expect(err?.message).toContain('step_submit_login');
  });

  it('scrubs registered secrets out of replay error messages (ADR 0013)', async () => {
    const report = await replay(wf(), {
      pageFactory: () => stubPage(),
      runner: async (ctx) => {
        const pwd = ctx.vault('portal_pass');
        throw new Error(`auth failed with password ${pwd}`);
      },
      runs: 1,
      vaultResolver: { resolve: () => 'hunter2' },
    });
    expect(report.replays[0]?.error?.message).toBe(
      'auth failed with password [REDACTED:portal_pass]',
    );
    expect(report.replays[0]?.error?.message).not.toContain('hunter2');
  });
});
