// IR interpreter: executes workflow steps directly against a Page.

import { describe, it, expect } from 'vitest';
import type { Workflow } from '@sfysh/ir';
import {
  AssertionError,
  createWorkflowContext,
  PostconditionViolation,
  StepFailure,
  VaultSecretMissingError,
} from '@sfysh/runtime';
import type { WorkflowContext } from '@sfysh/runtime';
import {
  createInterpreter,
  DEFAULT_MAX_ITERATIONS,
  InterpreterError,
  interpretWorkflow,
  LoopLimitError,
  recordPage,
  replay,
  replayFromCassette,
  StepTimeoutError,
  type StepTrace,
} from '../src/index.js';
import { loggingPage, type PageScript } from './helpers/logging-page.js';

function wf(steps: unknown[], extra: Record<string, unknown> = {}): Workflow {
  return {
    irVersion: '1.0.0',
    id: 'wf_interp',
    name: 'Interpreter',
    steps,
    ...extra,
  } as unknown as Workflow;
}

const nav = (id = 'nav_001', extra: Record<string, unknown> = {}) => ({
  id,
  intent: 'Open the page.',
  action: 'navigate',
  url: 'https://x.test/',
  ...extra,
});

const click = (id: string, candidates: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  intent: 'Click.',
  action: 'click',
  target: { candidates },
  ...extra,
});

function setup(script: PageScript = {}, secret?: string) {
  const { page, log } = loggingPage(script);
  const ctx: WorkflowContext = createWorkflowContext({
    page,
    ...(secret !== undefined ? { vaultResolver: { resolve: () => secret } } : {}),
  });
  return { ctx, log };
}

/** Run and return the StepFailure the interpreter threw. */
async function failure(run: Promise<void>): Promise<StepFailure> {
  const thrown = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(thrown).toBeInstanceOf(StepFailure);
  return thrown as StepFailure;
}

describe('interpreter: actions', () => {
  it('navigates, with and without waitUntil', async () => {
    const { ctx, log } = setup();
    await interpretWorkflow(
      ctx,
      wf([nav('nav_001'), nav('nav_002', { waitUntil: 'domcontentloaded' })]),
    );
    expect(log).toEqual([
      'goto("https://x.test/")',
      'goto("https://x.test/",{"waitUntil":"domcontentloaded"})',
    ]);
  });

  it('maps every selector kind to the matching Page method', async () => {
    const { ctx, log } = setup();
    await interpretWorkflow(
      ctx,
      wf([
        click('click_001', [{ kind: 'role', value: "button[name='Sign in']" }]),
        click('click_002', [{ kind: 'role', value: 'table' }]),
        click('click_003', [{ kind: 'testid', value: 'submit' }]),
        click('click_004', [{ kind: 'text', value: 'Accept' }]),
        click('click_005', [{ kind: 'label', value: 'Email' }]),
        click('click_006', [{ kind: 'css', value: '#go' }]),
      ]),
    );
    expect(log).toEqual([
      'getByRole("button",{"name":"Sign in"}).click',
      'getByRole("table").click',
      'getByTestId("submit").click',
      'getByText("Accept").click',
      'getByLabel("Email").click',
      'locator("#go").click',
    ]);
  });

  it('fills literals and resolves secrets through the vault', async () => {
    const { ctx, log } = setup({}, 'hunter2-secret');
    await interpretWorkflow(
      ctx,
      wf(
        [
          {
            id: 'fill_001',
            intent: 'Email.',
            action: 'fill',
            target: { candidates: [{ kind: 'label', value: 'Email' }] },
            value: 'a@b.test',
          },
          {
            id: 'fill_002',
            intent: 'Password.',
            action: 'fill',
            target: { candidates: [{ kind: 'label', value: 'Password' }] },
            value: { secret: 'portal_pass' },
          },
        ],
        { secrets: ['portal_pass'] },
      ),
    );
    expect(log).toEqual([
      'getByLabel("Email").fill("a@b.test")',
      'getByLabel("Password").fill("hunter2-secret")',
    ]);
    // The secret was registered, so the context scrubs it from here on.
    expect(ctx.redact('hunter2-secret')).toBe('[REDACTED:portal_pass]');
  });

  it('supplies parameter values from the params option', async () => {
    const workflow = wf([nav('nav_001', { url: { param: 'startUrl' } })], {
      parameters: { startUrl: { type: 'string' } },
    });
    const { ctx, log } = setup();
    await createInterpreter({ params: { startUrl: 'https://param.test/' } })(ctx, workflow);
    expect(log).toEqual(['goto("https://param.test/")']);

    const missing = await failure(interpretWorkflow(setup().ctx, workflow));
    expect(missing.cause).toBeInstanceOf(InterpreterError);
    expect(missing.message).toContain("no value supplied for parameter 'startUrl'");
  });

  it('extracts with the helper that matches the schema type', async () => {
    const { ctx, log } = setup({
      texts: { 'locator("table").locator("thead th, tr:first-child th")': ['sku'] },
      count: { 'locator("table").locator("tbody tr, tr:not(:first-child)")': 0 },
    });
    const extract = (id: string, css: string, schema: unknown) => ({
      id,
      intent: 'Read.',
      action: 'extract',
      target: { candidates: [{ kind: 'css', value: css }] },
      schema,
    });
    await interpretWorkflow(
      ctx,
      wf([
        extract('extract_001', 'h1', { type: 'string' }),
        extract('extract_002', 'li', { type: 'array', items: { type: 'string' } }),
        extract('extract_003', 'table', { sku: 'string' }),
      ]),
    );
    expect(log).toEqual([
      'locator("h1").allTextContents',
      'locator("li").allTextContents',
      'locator("table").locator("thead th, tr:first-child th").allTextContents',
      'locator("table").locator("tbody tr, tr:not(:first-child)").count',
    ]);
  });

  it('waits on a condition and on a fixed duration', async () => {
    const { ctx, log } = setup();
    await interpretWorkflow(
      ctx,
      wf([
        {
          id: 'wait_001',
          intent: 'Wait.',
          action: 'wait',
          forCondition: { selectorVisible: '#ready' },
        },
        { id: 'wait_002', intent: 'Pause.', action: 'wait', millis: 250 },
        { id: 'wait_003', intent: 'No-op.', action: 'wait' },
      ]),
    );
    expect(log).toEqual(['locator("#ready").isVisible', 'waitForTimeout(250)']);
  });

  it('asserts a condition and fails with AssertionError when it does not hold', async () => {
    const assertStep = {
      id: 'assert_001',
      intent: 'Check.',
      action: 'assert',
      condition: { textPresent: 'Welcome' },
    };

    await expect(interpretWorkflow(setup().ctx, wf([assertStep]))).resolves.toBeUndefined();

    const { ctx } = setup({ count: { 'getByText("Welcome")': 0 } });
    const thrown = await failure(interpretWorkflow(ctx, wf([assertStep])));
    expect(thrown.cause).toBeInstanceOf(AssertionError);
    expect(thrown.step).toEqual({ id: 'assert_001', action: 'assert' });
  });
});

describe('interpreter: control flow', () => {
  const guard = {
    id: 'guard_001',
    intent: 'Dismiss the banner if shown.',
    action: 'guard',
    if: { selectorVisible: '#banner' },
    then: [click('click_then', [{ kind: 'css', value: '#accept' }])],
    else: [click('click_else', [{ kind: 'css', value: '#continue' }])],
  };

  it('runs the then branch when the guard condition holds', async () => {
    const { ctx, log } = setup();
    await interpretWorkflow(ctx, wf([guard]));
    expect(log).toEqual(['locator("#banner").isVisible', 'locator("#accept").click']);
  });

  it('runs the else branch when it does not, and nothing when there is no else', async () => {
    const { ctx, log } = setup({ visible: { 'locator("#banner")': false } });
    await interpretWorkflow(ctx, wf([guard]));
    expect(log).toEqual(['locator("#banner").isVisible', 'locator("#continue").click']);

    const noElse = setup({ visible: { 'locator("#banner")': false } });
    const { else: _dropped, ...withoutElse } = guard;
    await interpretWorkflow(noElse.ctx, wf([withoutElse]));
    expect(noElse.log).toEqual(['locator("#banner").isVisible']);
  });

  it('repeats a while loop until the condition stops holding', async () => {
    const { ctx, log } = setup({ visible: { 'locator(".more")': [true, true, false] } });
    const traces: StepTrace[] = [];
    await createInterpreter({ onStep: (t) => traces.push(t) })(
      ctx,
      wf([
        {
          id: 'loop_001',
          intent: 'Load everything.',
          action: 'loop',
          while: { selectorVisible: '.more' },
          do: [click('click_more', [{ kind: 'css', value: '.more' }])],
        },
      ]),
    );
    expect(log).toEqual([
      'locator(".more").isVisible',
      'locator(".more").click',
      'locator(".more").isVisible',
      'locator(".more").click',
      'locator(".more").isVisible',
    ]);
    expect(traces.at(-1)).toMatchObject({ stepId: 'loop_001', status: 'ok', iterations: 2 });
  });

  it('runs a foreach body once per matched element', async () => {
    const { ctx, log } = setup({ all: { 'locator("tr")': 3 } });
    await interpretWorkflow(
      ctx,
      wf([
        {
          id: 'loop_001',
          intent: 'Each row.',
          action: 'loop',
          foreach: { candidates: [{ kind: 'css', value: 'tr' }] },
          do: [click('click_row', [{ kind: 'css', value: '.open' }])],
        },
      ]),
    );
    expect(log).toEqual([
      'locator("tr").all',
      'locator(".open").click',
      'locator(".open").click',
      'locator(".open").click',
    ]);
  });

  it('stops a runaway while loop at maxIterations', async () => {
    const { ctx, log } = setup();
    const thrown = await failure(
      interpretWorkflow(
        ctx,
        wf([
          {
            id: 'loop_001',
            intent: 'Never ends.',
            action: 'loop',
            while: { selectorVisible: '.more' },
            maxIterations: 3,
            do: [click('click_more', [{ kind: 'css', value: '.more' }])],
          },
        ]),
      ),
    );
    expect(thrown.cause).toBeInstanceOf(LoopLimitError);
    expect((thrown.cause as LoopLimitError).maxIterations).toBe(3);
    expect(thrown.step.id).toBe('loop_001');
    // Three full iterations ran; the fourth was refused before its body.
    expect(log.filter((l) => l.endsWith('.click'))).toHaveLength(3);
  });

  it('applies the schema default cap when maxIterations is not set', async () => {
    const { ctx, log } = setup({ all: { 'locator("tr")': DEFAULT_MAX_ITERATIONS + 5 } });
    const thrown = await failure(
      interpretWorkflow(
        ctx,
        wf([
          {
            id: 'loop_001',
            intent: 'Each row.',
            action: 'loop',
            foreach: { candidates: [{ kind: 'css', value: 'tr' }] },
            do: [click('click_row', [{ kind: 'css', value: '.open' }])],
          },
        ]),
      ),
    );
    expect(thrown.cause).toBeInstanceOf(LoopLimitError);
    expect(log.filter((l) => l.endsWith('.click'))).toHaveLength(DEFAULT_MAX_ITERATIONS);
  });

  it('refuses a control condition it cannot evaluate, instead of guessing', async () => {
    const thrown = await failure(
      interpretWorkflow(
        setup().ctx,
        wf([
          {
            id: 'guard_001',
            intent: 'If the response was OK.',
            action: 'guard',
            if: { responseStatus: 200 },
            then: [nav('nav_inner')],
          },
        ]),
      ),
    );
    expect(thrown.cause).toBeInstanceOf(InterpreterError);
    expect(thrown.message).toContain('cannot be evaluated');
    expect(thrown.step.id).toBe('guard_001');
  });
});

describe('interpreter: conditions, timeouts and attribution', () => {
  it('checks pre before the action and post after it', async () => {
    const { ctx, log } = setup({
      url: 'https://x.test/dashboard',
      count: { 'locator(".spinner")': 0 },
    });
    await interpretWorkflow(
      ctx,
      wf([
        click('click_001', [{ kind: 'css', value: '#go' }], {
          pre: [{ selectorVisible: '#go' }],
          post: [{ urlMatches: '/dashboard' }, { selectorAbsent: '.spinner' }],
        }),
      ]),
    );
    expect(log).toEqual([
      'locator("#go").isVisible',
      'locator("#go").click',
      'url',
      'locator(".spinner").count',
    ]);
  });

  it('does not run the action when a precondition is violated', async () => {
    const { ctx, log } = setup({ visible: { 'locator("#go")': false } });
    const thrown = await failure(
      interpretWorkflow(
        ctx,
        wf([
          click('click_001', [{ kind: 'css', value: '#go' }], {
            pre: [{ selectorVisible: '#go' }],
          }),
        ]),
      ),
    );
    expect(thrown.cause).toBeInstanceOf(PostconditionViolation);
    expect((thrown.cause as PostconditionViolation).phase).toBe('pre');
    expect(log).toEqual(['locator("#go").isVisible']);
  });

  it('attributes a failed action to its step and selector', async () => {
    const { ctx } = setup({ failAction: { 'getByTestId("submit")': 'Timeout 30000ms exceeded.' } });
    const thrown = await failure(
      interpretWorkflow(
        ctx,
        wf([nav(), click('click_002', [{ kind: 'testid', value: 'submit' }])]),
      ),
    );
    expect(thrown.step).toEqual({
      id: 'click_002',
      action: 'click',
      selector: { kind: 'testid', value: 'submit' },
    });
    expect(thrown.message).toBe('Timeout 30000ms exceeded.');
  });

  it('keeps the innermost step for a failure inside nested bodies', async () => {
    const { ctx } = setup({ failAction: { 'locator(".open")': 'detached' } });
    const thrown = await failure(
      interpretWorkflow(
        ctx,
        wf([
          {
            id: 'loop_001',
            intent: 'Each row.',
            action: 'loop',
            foreach: { candidates: [{ kind: 'css', value: 'tr' }] },
            do: [
              {
                id: 'guard_002',
                intent: 'If open.',
                action: 'guard',
                if: { selectorVisible: '.open' },
                then: [click('click_003', [{ kind: 'css', value: '.open' }])],
              },
            ],
          },
        ]),
      ),
    );
    expect(thrown.step.id).toBe('click_003');
  });

  it('fails a step that runs past its timeoutMs', async () => {
    const { page } = loggingPage();
    const slow = { ...page, goto: () => new Promise<void>(() => {}) };
    const ctx = createWorkflowContext({ page: slow });
    const started = Date.now();
    const thrown = await failure(interpretWorkflow(ctx, wf([nav('nav_001', { timeoutMs: 30 })])));
    expect(thrown.cause).toBeInstanceOf(StepTimeoutError);
    expect((thrown.cause as StepTimeoutError).timeoutMs).toBe(30);
    expect(thrown.step.id).toBe('nav_001');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('treats a missing or zero timeoutMs as no limit', async () => {
    const { ctx, log } = setup();
    await interpretWorkflow(ctx, wf([nav('nav_001', { timeoutMs: 0 }), nav('nav_002')]));
    expect(log).toHaveLength(2);
  });

  it('lets a missing vault secret surface as itself, attributed to the step', async () => {
    const { page } = loggingPage();
    const ctx = createWorkflowContext({ page, vaultResolver: { resolve: () => undefined } });
    const thrown = await failure(
      interpretWorkflow(
        ctx,
        wf(
          [
            {
              id: 'fill_001',
              intent: 'Password.',
              action: 'fill',
              target: { candidates: [{ kind: 'label', value: 'Password' }] },
              value: { secret: 'portal_pass' },
            },
          ],
          { secrets: ['portal_pass'] },
        ),
      ),
    );
    expect(thrown.cause).toBeInstanceOf(VaultSecretMissingError);
    expect(thrown.step.id).toBe('fill_001');
  });

  it('rejects an invalid workflow before touching the page', async () => {
    const { ctx, log } = setup();
    const invalid = wf([nav('same_id'), nav('same_id')]);
    await expect(interpretWorkflow(ctx, invalid)).rejects.toThrow(InterpreterError);
    await expect(interpretWorkflow(ctx, invalid)).rejects.toThrow(/failed IR validation/);
    expect(log).toEqual([]);
  });

  it('refuses a visual selector', async () => {
    const thrown = await failure(
      interpretWorkflow(
        setup().ctx,
        wf([click('click_001', [{ kind: 'visual', value: 'emb_4f2a' }])]),
      ),
    );
    expect(thrown.cause).toBeInstanceOf(InterpreterError);
    expect(thrown.message).toContain('visual');
  });
});

describe('interpreter: ranked candidates', () => {
  const candidates = [
    { kind: 'role', value: "button[name='Sign in']" },
    { kind: 'testid', value: 'login-submit' },
    { kind: 'text', value: 'Sign in' },
  ];
  const broken = {
    failAction: { 'getByRole("button",{"name":"Sign in"})': 'Timeout: no such button' },
  };

  it('uses only the first candidate by default, as generated code does', async () => {
    const { ctx, log } = setup(broken);
    const thrown = await failure(interpretWorkflow(ctx, wf([click('click_001', candidates)])));
    expect(thrown.step.selector).toEqual(candidates[0]);
    expect(log).toEqual(['getByRole("button",{"name":"Sign in"}).click']);
  });

  it('falls through to the next candidate when asked, and reports which one worked', async () => {
    const { ctx, log } = setup(broken);
    const traces: StepTrace[] = [];
    await createInterpreter({ candidates: 'fallthrough', onStep: (t) => traces.push(t) })(
      ctx,
      wf([click('click_001', candidates)]),
    );
    expect(log).toEqual([
      'getByRole("button",{"name":"Sign in"}).click',
      'getByTestId("login-submit").click',
    ]);
    expect(traces).toEqual([
      expect.objectContaining({
        stepId: 'click_001',
        status: 'ok',
        candidateIndex: 1,
        selector: { kind: 'testid', value: 'login-submit' },
      }),
    ]);
  });

  it('does not try later candidates when the first one works', async () => {
    const { ctx, log } = setup();
    const traces: StepTrace[] = [];
    await createInterpreter({ candidates: 'fallthrough', onStep: (t) => traces.push(t) })(
      ctx,
      wf([click('click_001', candidates)]),
    );
    expect(log).toEqual(['getByRole("button",{"name":"Sign in"}).click']);
    expect(traces[0]?.candidateIndex).toBe(0);
  });

  it('reports the primary candidate and its error when every candidate fails', async () => {
    const { ctx, log } = setup({
      failAction: {
        'getByRole("button",{"name":"Sign in"})': 'first error',
        'getByTestId("login-submit")': 'second error',
        'getByText("Sign in")': 'third error',
      },
    });
    const traces: StepTrace[] = [];
    const thrown = await failure(
      createInterpreter({ candidates: 'fallthrough', onStep: (t) => traces.push(t) })(
        ctx,
        wf([click('click_001', candidates)]),
      ),
    );
    expect(log).toHaveLength(3);
    expect(thrown.message).toBe('first error');
    expect(thrown.step.selector).toEqual(candidates[0]);
    expect(traces[0]).toMatchObject({ status: 'failed', candidateIndex: 0 });
  });

  it('skips visual candidates during fallthrough', async () => {
    const { ctx, log } = setup();
    await createInterpreter({ candidates: 'fallthrough' })(
      ctx,
      wf([
        click('click_001', [
          { kind: 'visual', value: 'emb_1' },
          { kind: 'css', value: '#go' },
        ]),
      ]),
    );
    expect(log).toEqual(['locator("#go").click']);
  });
});

describe('interpreter: trace', () => {
  it('reports each step as it finishes, inner steps before the step that contains them', async () => {
    const { ctx } = setup();
    const traces: StepTrace[] = [];
    await createInterpreter({ onStep: (t) => traces.push(t) })(
      ctx,
      wf([
        nav('nav_001'),
        {
          id: 'guard_002',
          intent: 'If shown.',
          action: 'guard',
          if: { selectorVisible: '#banner' },
          then: [click('click_003', [{ kind: 'css', value: '#accept' }])],
        },
      ]),
    );
    expect(traces.map((t) => [t.stepId, t.action, t.status])).toEqual([
      ['nav_001', 'navigate', 'ok'],
      ['click_003', 'click', 'ok'],
      ['guard_002', 'guard', 'ok'],
    ]);
    expect(traces[0]?.selector).toBeUndefined();
    expect(traces[1]).toMatchObject({
      selector: { kind: 'css', value: '#accept' },
      candidateIndex: 0,
    });
    for (const t of traces) expect(t.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('marks the failing step and every step around it as failed', async () => {
    const { ctx } = setup({ failAction: { 'locator("#accept")': 'nope' } });
    const traces: StepTrace[] = [];
    await failure(
      createInterpreter({ onStep: (t) => traces.push(t) })(
        ctx,
        wf([
          {
            id: 'guard_001',
            intent: 'If shown.',
            action: 'guard',
            if: { selectorVisible: '#banner' },
            then: [click('click_002', [{ kind: 'css', value: '#accept' }])],
          },
          nav('nav_003'),
        ]),
      ),
    );
    expect(traces.map((t) => [t.stepId, t.status])).toEqual([
      ['click_002', 'failed'],
      ['guard_001', 'failed'],
    ]);
  });
});

describe('interpreter as a verifier runner', () => {
  const workflow = wf(
    [
      nav('nav_001'),
      click('click_002', [{ kind: 'testid', value: 'submit' }], {
        post: [{ urlMatches: '/done' }],
      }),
    ],
    { id: 'wf_verify' },
  );

  it('plugs into replay() and produces attributed failures and snapshots', async () => {
    const report = await replay(workflow, {
      pageFactory: () =>
        loggingPage({ url: 'https://x.test/login', snapshot: '- button "Submit"' }).page,
      runner: interpretWorkflow,
      runs: 2,
    });
    expect(report.failed).toBe(2);
    expect(report.replays[0]?.error).toMatchObject({
      name: 'PostconditionViolation',
      stepId: 'click_002',
      action: 'click',
      selector: { kind: 'testid', value: 'submit' },
      phase: 'post',
      condition: { urlMatches: '/done' },
    });
    expect(report.replays[0]?.snapshot?.text).toBe('- button "Submit"');
  });

  it('passes a healthy workflow', async () => {
    const report = await replay(workflow, {
      pageFactory: () => loggingPage({ url: 'https://x.test/done' }).page,
      runner: interpretWorkflow,
    });
    expect(report.passed).toBe(3);
    expect(report.failed).toBe(0);
  });

  it('runs two versions of the same workflow id back to back with no registry in the way', async () => {
    const patched = wf([nav('nav_001'), click('click_002', [{ kind: 'css', value: '#submit' }])], {
      id: 'wf_verify',
    });
    const before = loggingPage({ url: 'https://x.test/done' });
    const after = loggingPage({ url: 'https://x.test/done' });
    await interpretWorkflow(createWorkflowContext({ page: before.page }), workflow);
    await interpretWorkflow(createWorkflowContext({ page: after.page }), patched);
    expect(before.log).toContain('getByTestId("submit").click');
    expect(after.log).toContain('locator("#submit").click');
  });

  it('replays an unchanged workflow from a cassette, and misses once a selector is patched', async () => {
    // Record a passing run through the interpreter.
    const live = loggingPage({ url: 'https://x.test/done' });
    const recording = recordPage(live.page, {
      workflowId: 'wf_verify',
      workflowName: 'Interpreter',
    });
    await interpretWorkflow(createWorkflowContext({ page: recording.page }), workflow);
    const cassette = recording.cassette();

    const same = await replayFromCassette(workflow, cassette, {
      runner: interpretWorkflow,
      runs: 1,
    });
    expect(same.passed).toBe(1);

    // A patch that changes the selector of a step with a condition on it
    // asks the page something the cassette never recorded. This is why a
    // cassette cannot be the evidence that a patch works.
    const patched = wf(
      [
        nav('nav_001'),
        click('click_002', [{ kind: 'css', value: '#submit' }], {
          pre: [{ selectorVisible: '#submit' }],
          post: [{ urlMatches: '/done' }],
        }),
      ],
      { id: 'wf_verify' },
    );
    const changed = await replayFromCassette(patched, cassette, {
      runner: interpretWorkflow,
      runs: 1,
    });
    expect(changed.failed).toBe(1);
    expect(changed.replays[0]?.error).toMatchObject({
      name: 'CassetteMissError',
      stepId: 'click_002',
    });
  });
});
