import { describe, expect, it } from 'vitest';
import { applyPatch, hashWorkflow, validateWorkflow } from '@sfysh/ir';
import type { Step, StepPatch, Workflow } from '@sfysh/ir';
import { ProviderError } from '@sfysh/providers';
import type { CompleteOptions, Completion, Message, Provider } from '@sfysh/providers';
import { createWorkflowContext } from '@sfysh/runtime';
import type { Page, PageSnapshot } from '@sfysh/runtime';
import {
  CANDIDATE_ORDER,
  checkPatch,
  DEFAULT_HEAL_MAX_TOKENS,
  DEFAULT_HEAL_TIMEOUT_MS,
  generateSelectorPatch,
  SELECTOR_SYSTEM_PROMPT,
  MAX_SELECTOR_CANDIDATES,
} from '../src/index.js';
import type { HealFailure, SelectorPatchInput, SelectorPatchResult } from '../src/index.js';

const SECRET = 'hunter2-very-secret';

const workflow = {
  irVersion: '1.0.0',
  id: 'wf_portal_login',
  name: 'Portal login',
  secrets: ['portal_pass'],
  steps: [
    {
      id: 'goto_001',
      intent: 'Open the login page.',
      action: 'navigate',
      url: 'https://portal.example.com/login',
    },
    {
      id: 'fill_002',
      intent: 'Enter the account password.',
      action: 'fill',
      target: { candidates: [{ kind: 'role', value: "textbox[name='Password']" }] },
      value: { secret: 'portal_pass' },
    },
    {
      id: 'click_003',
      intent: 'Submit the login form.',
      action: 'click',
      target: { candidates: [{ kind: 'role', value: "button[name='Sign in']" }] },
      post: [{ urlMatches: '/dashboard' }],
    },
  ],
} as unknown as Workflow;

type Loose = Record<string, unknown>;
const stepOf = (id: string) => (workflow.steps as unknown as Loose[]).find((s) => s.id === id)!;

const snapshot: PageSnapshot = {
  text: ['- heading "Welcome back" [level=1]', '- textbox "Passphrase"', '- button "Log in"'].join(
    '\n',
  ),
  truncated: false,
  originalLength: 70,
};

const failure: HealFailure = {
  name: 'TimeoutError',
  message: '[click_003] locator.click: Timeout 30000ms exceeded.',
  stepId: 'click_003',
  action: 'click',
  selector: { kind: 'role', value: "button[name='Sign in']" },
};

const newCandidates = [
  { kind: 'role', value: "button[name='Log in']" },
  { kind: 'css', value: 'form button[type=submit]' },
];

function answer(after: Loose, extra: Loose = {}): string {
  return JSON.stringify({
    after,
    rationale: 'The button was renamed from "Sign in" to "Log in".',
    confidence: 0.9,
    ...extra,
  });
}

const healed = (id = 'click_003', candidates: unknown[] = newCandidates): Loose => ({
  ...stepOf(id),
  target: { candidates },
});

interface Call {
  messages: Message[];
  options: CompleteOptions | undefined;
}

/** A provider that records what it was sent and answers from a script. */
function fakeProvider(reply: string | Partial<Completion> | Error): Provider & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    name: 'fake',
    calls,
    async complete(messages, options) {
      calls.push({ messages, options });
      if (reply instanceof Error) throw reply;
      const partial = typeof reply === 'string' ? { content: reply } : reply;
      return {
        content: '',
        stopReason: 'end',
        usage: { inputTokens: 1200, outputTokens: 90 },
        model: 'fake-model-2026',
        ...partial,
      };
    },
  };
}

function input(
  provider: Provider,
  overrides: Partial<SelectorPatchInput> = {},
): SelectorPatchInput {
  return {
    workflow,
    failure,
    snapshot,
    redact: (text) => text,
    provider,
    nonce: () => 'a1b2c3d4e5f60718',
    ...overrides,
  };
}

/** A real run context with the secret registered, so `redact` is the production one. */
function realRedact(): (text: string) => string {
  const ctx = createWorkflowContext({
    page: {} as Page,
    vaultResolver: { resolve: () => SECRET },
  });
  ctx.vault('portal_pass');
  return ctx.redact;
}

function patchOf(result: SelectorPatchResult): StepPatch {
  if (result.status !== 'patch' && result.status !== 'needs_approval') {
    throw new Error(`expected a patch, got ${JSON.stringify(result)}`);
  }
  return result.patch;
}

const candidatesOf = (patch: StepPatch) =>
  (patch.after as unknown as { target: { candidates: unknown[] } }).target.candidates;

describe('generateSelectorPatch(): a good answer', () => {
  it('uses a workflow that passes IR validation', () => {
    expect(validateWorkflow(workflow).valid).toBe(true);
  });

  it('returns a patch that passes every check and applies', async () => {
    const provider = fakeProvider(answer(healed()));
    const result = await generateSelectorPatch(input(provider));

    expect(result.status).toBe('patch');
    const patch = patchOf(result);
    expect(patch).toMatchObject({
      workflowId: 'wf_portal_login',
      baseHash: hashWorkflow(workflow),
      stepId: 'click_003',
      op: 'replace',
      confidence: 0.9,
    });
    expect(candidatesOf(patch)).toEqual(newCandidates);
    expect(checkPatch(patch, workflow, 'selector')).toEqual({ status: 'ok' });
    expect(applyPatch(workflow, patch).ok).toBe(true);
  });

  it('reports the model and token usage', async () => {
    const result = await generateSelectorPatch(input(fakeProvider(answer(healed()))));
    expect(result).toMatchObject({
      call: { model: 'fake-model-2026', usage: { inputTokens: 1200, outputTokens: 90 } },
    });
  });

  it('makes exactly one call, with the heal prompt, a timeout and an output cap', async () => {
    const provider = fakeProvider(answer(healed()));
    await generateSelectorPatch(input(provider));

    expect(provider.calls).toHaveLength(1);
    const { messages, options } = provider.calls[0]!;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0]!.content).toBe(SELECTOR_SYSTEM_PROMPT);
    expect(messages[1]!.content).toContain('button "Log in"');
    expect(options).toEqual({ maxTokens: 2000, timeoutMs: 60000 });
    expect(DEFAULT_HEAL_MAX_TOKENS).toBe(2000);
    expect(DEFAULT_HEAL_TIMEOUT_MS).toBe(60000);
  });

  it('passes the caller its own timeout, output cap and signal', async () => {
    const provider = fakeProvider(answer(healed()));
    const controller = new AbortController();
    await generateSelectorPatch(
      input(provider, { timeoutMs: 5000, maxTokens: 800, signal: controller.signal }),
    );
    const { options } = provider.calls[0]!;
    expect(options).toEqual({ maxTokens: 800, timeoutMs: 5000, signal: controller.signal });
    expect(options?.signal).toBe(controller.signal);
  });

  it('accepts an answer wrapped in a code fence', async () => {
    const provider = fakeProvider('```json\n' + answer(healed()) + '\n```');
    expect((await generateSelectorPatch(input(provider))).status).toBe('patch');
  });
});

describe('generateSelectorPatch(): redaction', () => {
  it('sends the whole request through the redaction function, system message included', async () => {
    // The prompt builder never redacts the system message, so a call that
    // sees it can only have come from the provider wrapper.
    const seen: string[] = [];
    const redact = (text: string) => {
      seen.push(text);
      return text;
    };
    await generateSelectorPatch(input(fakeProvider(answer(healed())), { redact }));
    expect(seen).toContain(SELECTOR_SYSTEM_PROMPT);
  });

  it('keeps a secret on the page, in the error and in the step away from the provider', async () => {
    const provider = fakeProvider(answer(healed()));
    await generateSelectorPatch(
      input(provider, {
        redact: realRedact(),
        snapshot: { ...snapshot, text: `${snapshot.text}\n- textbox "Password": ${SECRET}` },
        failure: { ...failure, message: `fill failed for value ${SECRET}` },
      }),
    );
    const sent = JSON.stringify(provider.calls[0]);
    expect(sent).not.toContain(SECRET);
    expect(sent).toContain('[REDACTED:portal_pass]');
  });

  it('redacts a provider error message', async () => {
    const provider = fakeProvider(
      new ProviderError(`request body rejected: ...${SECRET}...`, {
        code: 'server_error',
        provider: 'fake',
      }),
    );
    const result = await generateSelectorPatch(input(provider, { redact: realRedact() }));
    expect(result).toEqual({
      status: 'provider_error',
      code: 'server_error',
      retryable: true,
      message: 'request body rejected: ...[REDACTED:portal_pass]...',
    });
  });

  it('makes no call and throws when the redaction function is broken', async () => {
    const provider = fakeProvider(answer(healed()));
    const redact = (() => undefined) as unknown as (text: string) => string;
    await expect(generateSelectorPatch(input(provider, { redact }))).rejects.toThrow();
    expect(provider.calls).toHaveLength(0);
  });
});

describe('generateSelectorPatch(): candidate order', () => {
  it('lists the order as role, testid, label, text, css', () => {
    expect(CANDIDATE_ORDER).toEqual(['role', 'testid', 'label', 'text', 'css']);
  });

  it('puts the candidates in preference order, keeping the order within a kind', async () => {
    const given = [
      { kind: 'css', value: 'form button' },
      { kind: 'text', value: 'Log in' },
      { kind: 'role', value: "button[name='Log in']" },
      { kind: 'testid', value: 'login-submit' },
      { kind: 'role', value: 'button' },
    ];
    const result = await generateSelectorPatch(
      input(fakeProvider(answer(healed(undefined, given)))),
    );
    expect(candidatesOf(patchOf(result))).toEqual([
      { kind: 'role', value: "button[name='Log in']" },
      { kind: 'role', value: 'button' },
      { kind: 'testid', value: 'login-submit' },
      { kind: 'text', value: 'Log in' },
      { kind: 'css', value: 'form button' },
    ]);
  });

  it('drops exact repeats', async () => {
    const given = [...newCandidates, ...newCandidates, { kind: 'css', value: 'button' }];
    const result = await generateSelectorPatch(
      input(fakeProvider(answer(healed(undefined, given)))),
    );
    expect(candidatesOf(patchOf(result))).toEqual([
      ...newCandidates,
      { kind: 'css', value: 'button' },
    ]);
  });

  it('rejects a visual candidate', async () => {
    const given = [...newCandidates, { kind: 'visual', value: 'emb_4f2a' }];
    const result = await generateSelectorPatch(
      input(fakeProvider(answer(healed(undefined, given)))),
    );
    expect(result).toMatchObject({
      status: 'rejected',
      stage: 'candidates',
      code: 'visual_candidate',
    });
  });

  it('rejects more candidates than the limit', async () => {
    expect(MAX_SELECTOR_CANDIDATES).toBe(5);
    const given = Array.from({ length: 6 }, (_, i) => ({ kind: 'css', value: `button.v${i}` }));
    const result = await generateSelectorPatch(
      input(fakeProvider(answer(healed(undefined, given)))),
    );
    expect(result).toMatchObject({
      status: 'rejected',
      stage: 'candidates',
      code: 'too_many_candidates',
    });
  });
});

describe('generateSelectorPatch(): answers that are not a usable patch', () => {
  it('returns cannot_heal with the model rationale', async () => {
    const provider = fakeProvider(
      JSON.stringify({ cannotHeal: true, rationale: 'There is no submit button in the snapshot.' }),
    );
    expect(await generateSelectorPatch(input(provider))).toEqual({
      status: 'cannot_heal',
      rationale: 'There is no submit button in the snapshot.',
      call: { model: 'fake-model-2026', usage: { inputTokens: 1200, outputTokens: 90 } },
    });
  });

  it.each<[string, string | Partial<Completion>, string]>([
    ['a cut-off answer', { content: answer(healed()), stopReason: 'max_tokens' }, 'truncated'],
    ['a refusal', { content: '', stopReason: 'refusal' }, 'refused'],
    ['prose', 'Sure! Here is the patch you asked for.', 'not_json'],
    ['an extra key', answer(healed(), { stepId: 'goto_001' }), 'wrong_shape'],
    ['an invalid step', answer({ ...healed(), target: { candidates: [] } }), 'invalid_step'],
    ['a changed step id', answer({ ...healed(), id: 'click_999' }), 'invalid_patch'],
  ])('rejects %s at the response stage', async (_name, reply, code) => {
    const result = await generateSelectorPatch(input(fakeProvider(reply)));
    expect(result).toMatchObject({ status: 'rejected', stage: 'response', code });
    expect(result).toHaveProperty('call.model', 'fake-model-2026');
  });

  it.each<[string, Loose, string, string]>([
    ['a dropped post condition', { post: undefined }, 'scope', 'post_weakened'],
    ['an added condition', { pre: [{ textPresent: 'Welcome' }] }, 'class', 'field_not_allowed'],
    ['a reworded intent', { intent: 'Click anything.' }, 'class', 'field_not_allowed'],
    [
      'a changed action',
      { action: 'assert', condition: { textPresent: 'x' } },
      'scope',
      'action_changed',
    ],
    ['an unknown field', { script: 'fetch("https://evil.test")' }, 'scope', 'unknown_field'],
    ['unchanged candidates', { target: stepOf('click_003').target }, 'class', 'no_change'],
  ])('rejects %s at the policy stage', async (_name, changes, check, code) => {
    const after: Loose = { ...healed(), ...changes };
    for (const key of Object.keys(after)) if (after[key] === undefined) delete after[key];
    const result = await generateSelectorPatch(input(fakeProvider(answer(after))));

    expect(result).toMatchObject({ status: 'rejected', stage: 'policy' });
    if (result.status !== 'rejected' || result.stage !== 'policy') throw new Error('unreachable');
    expect(result.violations.map((v) => `${v.check}:${v.code}`)).toContain(`${check}:${code}`);
    expect(result.code).toBe(result.violations[0]!.code);
  });

  it('rejects a new origin and a catastrophic pattern smuggled into a condition', async () => {
    const after = {
      ...healed(),
      pre: [{ urlEquals: 'https://evil.test/login' }, { urlMatches: '(a+)+$' }],
    };
    const result = await generateSelectorPatch(input(fakeProvider(answer(after))));
    if (result.status !== 'rejected' || result.stage !== 'policy') throw new Error('not rejected');
    expect(result.violations.map((v) => `${v.check}:${v.code}`)).toEqual([
      'class:field_not_allowed',
      'reach:new_origin',
      'pattern:pattern_nested_quantifier',
    ]);
  });

  it('does not quote the model answer in a rejection', async () => {
    const after = { ...healed(), intent: 'SENTINEL intent', script: 'SENTINEL script' };
    const result = await generateSelectorPatch(input(fakeProvider(answer(after))));
    expect(result.status).toBe('rejected');
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
  });
});

describe('generateSelectorPatch(): a step that types a secret', () => {
  const secretFailure: HealFailure = { ...failure, stepId: 'fill_002', action: 'fill' };
  const retargeted = healed('fill_002', [{ kind: 'role', value: "textbox[name='Passphrase']" }]);

  it('returns needs_approval, never a plain patch, when the target changes', async () => {
    const provider = fakeProvider(answer(retargeted));
    const result = await generateSelectorPatch(input(provider, { failure: secretFailure }));

    expect(result.status).toBe('needs_approval');
    if (result.status !== 'needs_approval') throw new Error('unreachable');
    expect(result.approvals.map((a) => a.code)).toEqual(['secret_retargeted']);
    expect((result.patch.after as unknown as Loose).value).toEqual({ secret: 'portal_pass' });
  });

  it('rejects an answer that swaps the secret for a literal', async () => {
    const provider = fakeProvider(answer({ ...retargeted, value: 'hunter2' }));
    const result = await generateSelectorPatch(input(provider, { failure: secretFailure }));
    expect(result).toMatchObject({ status: 'rejected', stage: 'policy' });
  });
});

describe('generateSelectorPatch(): input the model is never asked about', () => {
  it.each<[string, Partial<SelectorPatchInput>, string]>([
    ['a failure with no step id', { failure: { ...failure, stepId: undefined } }, 'no_step_id'],
    [
      'a step that is not in the workflow',
      { failure: { ...failure, stepId: 'click_404' } },
      'step_not_found',
    ],
    ['an empty snapshot', { snapshot: { ...snapshot, text: '  ' } }, 'empty_snapshot'],
    [
      'an HTML snapshot',
      { snapshot: { ...snapshot, text: '<!doctype html><html>' } },
      'html_snapshot',
    ],
    ['a step with no target', { failure: { ...failure, stepId: 'goto_001' } }, 'no_target'],
  ])('rejects %s without calling the provider', async (_name, overrides, code) => {
    const provider = fakeProvider(answer(healed()));
    const result = await generateSelectorPatch(input(provider, overrides));
    expect(result).toMatchObject({ status: 'rejected', stage: 'input', code });
    expect(provider.calls).toHaveLength(0);
  });

  it('throws for a bad argument', async () => {
    const provider = fakeProvider(answer(healed()));
    await expect(generateSelectorPatch(input(provider, { maxSnapshotChars: -1 }))).rejects.toThrow(
      RangeError,
    );
    expect(provider.calls).toHaveLength(0);
  });
});

describe('generateSelectorPatch(): provider failures', () => {
  it.each<[ProviderError['code'], boolean]>([
    ['timeout', true],
    ['rate_limit', true],
    ['server_error', true],
    ['auth', false],
    ['aborted', false],
    ['context_length', false],
  ])('returns provider_error for %s', async (code, retryable) => {
    const provider = fakeProvider(new ProviderError('call failed', { code, provider: 'fake' }));
    expect(await generateSelectorPatch(input(provider))).toEqual({
      status: 'provider_error',
      code,
      retryable,
      message: 'call failed',
    });
    // One call is one attempt. Retrying is the caller's decision.
    expect(provider.calls).toHaveLength(1);
  });

  it('lets an error that is not a ProviderError through', async () => {
    const provider = fakeProvider(new TypeError('bug in a provider'));
    await expect(generateSelectorPatch(input(provider))).rejects.toThrow(TypeError);
  });
});

describe('checkPatch()', () => {
  const base = (id: string, after: Loose): StepPatch => ({
    workflowId: workflow.id,
    baseHash: hashWorkflow(workflow),
    stepId: id,
    op: 'replace',
    before: stepOf(id) as unknown as Step,
    after: after as unknown as Step,
    rationale: 'test',
  });

  it('is ok for a clean selector patch', () => {
    expect(checkPatch(base('click_003', healed()), workflow, 'selector')).toEqual({ status: 'ok' });
  });

  it('is needs_approval for a retargeted secret', () => {
    const patch = base('fill_002', healed('fill_002', [{ kind: 'css', value: '#pw' }]));
    expect(checkPatch(patch, workflow, 'selector')).toMatchObject({ status: 'needs_approval' });
  });

  it('rejects when any check objects, even if another asks for approval', () => {
    const after = { ...healed('fill_002', [{ kind: 'css', value: '#pw' }]), timeoutMs: 1 };
    const verdict = checkPatch(base('fill_002', after), workflow, 'selector');
    expect(verdict).toMatchObject({
      status: 'rejected',
      violations: [{ check: 'class', code: 'field_not_allowed', path: '/after/timeoutMs' }],
    });
  });

  it('collects violations from all four checks', () => {
    const after = {
      ...healed(),
      post: [{ urlMatches: '(a+)+$' }],
      pre: [{ urlEquals: 'https://evil.test/' }],
    };
    const verdict = checkPatch(base('click_003', after), workflow, 'selector');
    if (verdict.status !== 'rejected') throw new Error('not rejected');
    expect(new Set(verdict.violations.map((v) => v.check))).toEqual(
      new Set(['scope', 'class', 'reach', 'pattern']),
    );
  });

  it('holds an insert to the insert-step class', () => {
    const patch: StepPatch = {
      ...base('click_003', {
        id: 'fill_900',
        intent: 'Enter a phone number.',
        action: 'fill',
        target: { candidates: [{ kind: 'label', value: 'Phone' }] },
        value: '0400 000 000',
      }),
      op: 'insert_before',
    };
    delete patch.before;
    expect(checkPatch(patch, workflow, 'insert_step')).toMatchObject({
      status: 'rejected',
      violations: [{ check: 'class', code: 'action_not_allowed' }],
    });
  });
});
