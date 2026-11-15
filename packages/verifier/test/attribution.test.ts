// Replay outcomes carry step attribution, a triage-ready cause, and a page
// snapshot for failed replays. Cassettes record and replay the snapshot.

import { describe, it, expect, beforeEach } from 'vitest';
import type { Workflow } from '@sfysh/ir';
import { IR_VERSION } from '@sfysh/ir';
import {
  assertCondition,
  ExtractionError,
  PostconditionViolation,
  resetWorkflows,
  step,
  StepFailure,
  workflow,
} from '@sfysh/runtime';
import type { Locator, Page } from '@sfysh/runtime';
import {
  CassetteMissError,
  fakePageFromCassette,
  humanReport,
  jsonReport,
  parseCassette,
  recordPage,
  replay,
  replayFromCassette,
  runRegisteredWorkflow,
  serialiseCassette,
} from '../src/index.js';

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
    url: () => 'https://example.com/login',
    locator: () => stubLocator(),
    getByRole: () => stubLocator(),
    getByTestId: () => stubLocator(),
    getByText: () => stubLocator(),
    getByLabel: () => stubLocator(),
    waitForTimeout: async () => {},
  };
  return { ...base, ...overrides };
}

const wf: Workflow = {
  irVersion: IR_VERSION,
  id: 'wf_attr',
  name: 'Attribution workflow',
  steps: [{ id: 'click_001', intent: 'Click.', action: 'navigate', url: 'https://example.com' }],
};

const clickInfo = {
  id: 'click_001',
  action: 'click',
  selector: { kind: 'testid' as const, value: 'submit' },
};

describe('replay: failure attribution', () => {
  it('reports step, action and selector for a failed action', async () => {
    const report = await replay(wf, {
      pageFactory: () => stubPage(),
      runs: 1,
      runner: async (ctx) => {
        await step(ctx, clickInfo, async () => {
          throw new ExtractionError("Column 'qty' not found");
        });
      },
    });

    expect(report.replays[0]?.error).toMatchObject({
      name: 'ExtractionError',
      message: "[click_001] Column 'qty' not found",
      stepId: 'click_001',
      action: 'click',
      selector: { kind: 'testid', value: 'submit' },
    });
  });

  it('reports the violated condition and reason', async () => {
    const report = await replay(wf, {
      pageFactory: () => stubPage(),
      runs: 1,
      runner: async (ctx) => {
        await step(ctx, clickInfo, async () => {
          await assertCondition(ctx, 'click_001', 'post', { urlMatches: '/dashboard' });
        });
      },
    });

    expect(report.replays[0]?.error).toMatchObject({
      name: 'PostconditionViolation',
      stepId: 'click_001',
      phase: 'post',
      condition: { urlMatches: '/dashboard' },
      reason: "URL 'https://example.com/login' did not match '/dashboard'",
    });
  });

  it('keeps the original error reachable for triage without serialising it', async () => {
    const original = new ExtractionError('gone');
    const report = await replay(wf, {
      pageFactory: () => stubPage(),
      runs: 1,
      runner: async (ctx) => {
        await step(ctx, clickInfo, async () => {
          throw original;
        });
      },
    });

    const error = report.replays[0]?.error;
    expect(error?.cause).toBe(original);
    expect(error?.cause).not.toBeInstanceOf(StepFailure);
    expect(Object.keys(error ?? {})).not.toContain('cause');
    expect(jsonReport(report)).not.toContain('"cause"');
  });

  it('includes the attribution in both reporters', async () => {
    const report = await replay(wf, {
      pageFactory: () => stubPage({ snapshot: async () => '- button "Go"' }),
      runs: 1,
      runner: async (ctx) => {
        await step(ctx, clickInfo, async () => {
          throw new Error('nope');
        });
      },
    });

    const human = humanReport(report);
    expect(human).toContain('error: Error: [click_001] nope');
    expect(human).toContain('at: step click_001, action click, selector testid="submit"');
    expect(human).toContain('page snapshot captured (13 chars)');

    const parsed = JSON.parse(jsonReport(report)) as {
      replays: Array<{ error: Record<string, unknown>; snapshot?: unknown }>;
    };
    expect(parsed.replays[0]?.error).toEqual({
      message: '[click_001] nope',
      name: 'Error',
      stepId: 'click_001',
      action: 'click',
      selector: { kind: 'testid', value: 'submit' },
    });
    // Page content stays out of the JSON report.
    expect(parsed.replays[0]?.snapshot).toBeUndefined();
  });
});

describe('replay: page snapshot', () => {
  it('captures a snapshot for a failed replay before the page is disposed', async () => {
    let open = true;
    const report = await replay(wf, {
      pageFactory: () =>
        stubPage({
          snapshot: async () => {
            if (!open) throw new Error('page closed');
            return '- heading "Login"';
          },
        }),
      runs: 1,
      runner: async () => {
        throw new Error('broken');
      },
      dispose: () => {
        open = false;
      },
    });

    expect(report.replays[0]?.snapshot).toEqual({
      text: '- heading "Login"',
      truncated: false,
      originalLength: 17,
    });
  });

  it('captures a snapshot when the terminal postcondition is violated', async () => {
    const withPost: Workflow = {
      ...wf,
      steps: [{ ...wf.steps[0]!, post: [{ urlMatches: '/dashboard' }] }],
    };
    const report = await replay(withPost, {
      pageFactory: () => stubPage({ snapshot: async () => 'still on login' }),
      runs: 1,
      runner: async () => {},
    });
    expect(report.replays[0]?.status).toBe('failed');
    expect(report.replays[0]?.error).toBeUndefined();
    expect(report.replays[0]?.snapshot?.text).toBe('still on login');
  });

  it('takes no snapshot of a passing replay', async () => {
    let calls = 0;
    const report = await replay(wf, {
      pageFactory: () =>
        stubPage({
          snapshot: async () => {
            calls++;
            return 'x';
          },
        }),
      runs: 2,
      runner: async () => {},
    });
    expect(report.passed).toBe(2);
    expect(calls).toBe(0);
    expect(report.replays[0]?.snapshot).toBeUndefined();
  });

  it('honours snapshot: false and the size cap', async () => {
    const pageFactory = () => stubPage({ snapshot: async () => 'x'.repeat(50) });
    const runner = async () => {
      throw new Error('broken');
    };

    const off = await replay(wf, { pageFactory, runner, runs: 1, snapshot: false });
    expect(off.replays[0]?.snapshot).toBeUndefined();

    const capped = await replay(wf, { pageFactory, runner, runs: 1, snapshot: { maxChars: 10 } });
    expect(capped.replays[0]?.snapshot).toEqual({
      text: 'xxxxxxxxxx',
      truncated: true,
      originalLength: 50,
    });
  });

  it('redacts secrets in the snapshot', async () => {
    const report = await replay(wf, {
      pageFactory: () => stubPage({ snapshot: async () => '- textbox: hunter2-secret' }),
      runs: 1,
      vaultResolver: { resolve: () => 'hunter2-secret' },
      runner: async (ctx) => {
        ctx.vault('portal_pass');
        throw new Error('broken');
      },
    });
    expect(report.replays[0]?.snapshot?.text).toBe('- textbox: [REDACTED:portal_pass]');
  });
});

describe('runRegisteredWorkflow', () => {
  beforeEach(() => {
    resetWorkflows();
  });

  it('executes the registered workflow and preserves step attribution', async () => {
    workflow('wf_attr', async (ctx) => {
      await step(ctx, clickInfo, async () => {
        throw new PostconditionViolation({
          stepId: 'click_001',
          phase: 'pre',
          condition: { selectorVisible: '#go' },
          reason: "Selector '#go' not visible",
        });
      });
    });

    const report = await replay(wf, {
      pageFactory: () => stubPage(),
      runs: 1,
      runner: runRegisteredWorkflow,
    });

    expect(report.replays[0]?.error).toMatchObject({
      stepId: 'click_001',
      action: 'click',
      phase: 'pre',
      selector: { kind: 'testid', value: 'submit' },
    });
  });

  it('fails the replay with a clear message when nothing is registered', async () => {
    const report = await replay(wf, {
      pageFactory: () => stubPage(),
      runs: 1,
      runner: runRegisteredWorkflow,
    });
    expect(report.replays[0]?.error?.message).toContain('No workflow registered with id "wf_attr"');
  });
});

describe('cassettes and snapshots', () => {
  const meta = {
    workflowId: 'wf_attr',
    workflowName: 'Attribution workflow',
    now: () => new Date('2026-11-15T00:00:00.000Z'),
  };

  it('records the snapshot as a redacted string value and replays it', async () => {
    const recording = recordPage(
      stubPage({ snapshot: async () => '- textbox "Password": hunter2-secret' }),
      meta,
    );
    recording.setRedact((s) => s.split('hunter2-secret').join('[REDACTED:pw]'));
    await recording.page.snapshot!();

    const cassette = parseCassette(serialiseCassette(recording.cassette()));
    expect(cassette.queries['snapshot']).toEqual({
      kind: 'string',
      value: '- textbox "Password": [REDACTED:pw]',
    });

    const fake = fakePageFromCassette(cassette);
    await expect(fake.snapshot!()).resolves.toBe('- textbox "Password": [REDACTED:pw]');
  });

  it('throws from the recording page when the live backend has no snapshot', async () => {
    const recording = recordPage(stubPage(), meta);
    await expect(recording.page.snapshot!()).rejects.toThrow(/does not support snapshot/);
    expect(recording.cassette().queries['snapshot']).toBeUndefined();
  });

  it('a cassette without a snapshot misses, and a failed dry-run simply has none', async () => {
    const recording = recordPage(stubPage(), meta);
    recording.page.url();
    const cassette = recording.cassette();

    await expect(fakePageFromCassette(cassette).snapshot!()).rejects.toThrow(CassetteMissError);

    const report = await replayFromCassette(wf, cassette, {
      runs: 1,
      runner: async () => {
        throw new Error('broken');
      },
    });
    expect(report.replays[0]?.status).toBe('failed');
    expect(report.replays[0]?.error?.message).toBe('broken');
    expect(report.replays[0]?.snapshot).toBeUndefined();
  });

  it('a failed dry-run returns the snapshot recorded with the cassette', async () => {
    const recording = recordPage(
      stubPage({ snapshot: async () => '- alert "Session expired"' }),
      meta,
    );
    await recording.page.snapshot!();

    const report = await replayFromCassette(wf, recording.cassette(), {
      runs: 1,
      runner: async () => {
        throw new Error('broken');
      },
    });
    expect(report.replays[0]?.snapshot?.text).toBe('- alert "Session expired"');
  });
});
