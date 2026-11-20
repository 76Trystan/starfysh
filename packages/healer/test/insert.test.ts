import { describe, expect, it } from 'vitest';
import { applyPatch, hashWorkflow, validateWorkflow } from '@sfysh/ir';
import type { Step, StepPatch, Workflow } from '@sfysh/ir';
import type { CompleteOptions, Completion, Message, Provider } from '@sfysh/providers';
import type { PageSnapshot } from '@sfysh/runtime';
import {
  buildHealPrompt,
  checkPatch,
  checkPatchClass,
  generateInsertStepPatch,
  HEALED_STEP_ID_PREFIX,
  INSERT_STEP_SYSTEM_PROMPT,
  INSERTED_STEP_MAX_TIMEOUT_MS,
  parseHealResponse,
  SELECTOR_SYSTEM_PROMPT,
  systemPromptFor,
} from '../src/index.js';
import type { GeneratePatchInput, GeneratePatchResult, HealFailure } from '../src/index.js';

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

const snapshot: PageSnapshot = {
  text: [
    '- dialog "We value your privacy"',
    '  - button "Accept all"',
    '  - button "Reject all"',
    '- button "Sign in"',
  ].join('\n'),
  truncated: false,
  originalLength: 90,
};

const failure: HealFailure = {
  name: 'TimeoutError',
  message: '[click_003] locator.click: element is covered by another element.',
  stepId: 'click_003',
  action: 'click',
  selector: { kind: 'role', value: "button[name='Sign in']" },
};

const dismiss = {
  intent: 'Dismiss the privacy dialog, which now covers the sign-in button.',
  action: 'click',
  target: {
    candidates: [
      { kind: 'css', value: 'dialog button.reject' },
      { kind: 'role', value: "button[name='Reject all']" },
    ],
  },
};

const waitForPanel = {
  intent: 'Wait for the privacy dialog to close.',
  action: 'wait',
  forCondition: { selectorAbsent: 'dialog' },
};

function answer(step: unknown, extra: Loose = {}): string {
  return JSON.stringify({
    step,
    rationale: 'A privacy dialog now covers the form.',
    confidence: 0.8,
    ...extra,
  });
}

interface Call {
  messages: Message[];
  options: CompleteOptions | undefined;
}

function fakeProvider(reply: string | Partial<Completion>): Provider & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    name: 'fake',
    calls,
    async complete(messages, options) {
      calls.push({ messages, options });
      const partial = typeof reply === 'string' ? { content: reply } : reply;
      return {
        content: '',
        stopReason: 'end',
        usage: { inputTokens: 1000, outputTokens: 80 },
        model: 'fake-model-2026',
        ...partial,
      };
    },
  };
}

function input(
  provider: Provider,
  overrides: Partial<GeneratePatchInput> = {},
): GeneratePatchInput {
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

function promptFor(wf: Workflow = workflow) {
  return buildHealPrompt({
    workflow: wf,
    failure,
    snapshot,
    redact: (text) => text,
    patchClass: 'insert_step',
    nonce: () => 'a1b2c3d4e5f60718',
  });
}

const completion = (content: string): Completion => ({
  content,
  stopReason: 'end',
  usage: { inputTokens: 1, outputTokens: 1 },
  model: 'fake',
});

function patchOf(result: GeneratePatchResult): StepPatch {
  if (result.status !== 'patch') throw new Error(`expected a patch, got ${JSON.stringify(result)}`);
  return result.patch;
}

describe('buildHealPrompt(): insert-step class', () => {
  it('uses a workflow that passes IR validation', () => {
    expect(validateWorkflow(workflow).valid).toBe(true);
  });

  it('gives the insert-step instructions and leaves the selector ones as the default', () => {
    expect(promptFor().messages[0]!.content).toBe(INSERT_STEP_SYSTEM_PROMPT);
    const selector = buildHealPrompt({ workflow, failure, snapshot, redact: (t) => t });
    expect(selector.messages[0]!.content).toBe(SELECTOR_SYSTEM_PROMPT);
    expect(selector).toMatchObject({ patchClass: 'selector', op: 'replace' });
    expect(selector.newStepId).toBeUndefined();
    expect(systemPromptFor('insert_step')).toBe(INSERT_STEP_SYSTEM_PROMPT);
    expect(systemPromptFor('selector')).toBe(SELECTOR_SYSTEM_PROMPT);
  });

  it('keeps the two instruction sets distinct and free of template leftovers', () => {
    expect(INSERT_STEP_SYSTEM_PROMPT).not.toBe(SELECTOR_SYSTEM_PROMPT);
    for (const prompt of [INSERT_STEP_SYSTEM_PROMPT, SELECTOR_SYSTEM_PROMPT]) {
      expect(prompt).not.toContain('${');
      expect(prompt).toContain('<<<DATA name id>>>');
      expect(prompt).toContain('cannotHeal');
      expect(prompt).toContain('Never use the kind "visual"');
      // The role format matches names as substrings; the exact form must be
      // taught, or the model cannot tell 'Filter' from 'Filter all'.
      expect(prompt).toContain("button[name='Filter'][exact=true]");
    }
    expect(INSERT_STEP_SYSTEM_PROMPT).toContain('"click" or "wait"');
    expect(INSERT_STEP_SYSTEM_PROMPT).toContain('{"step":');
    expect(SELECTOR_SYSTEM_PROMPT).toContain('{"after":');
  });

  it('fixes the operation and chooses an unused id for the new step', () => {
    expect(HEALED_STEP_ID_PREFIX).toBe('healed_');
    expect(promptFor()).toMatchObject({
      patchClass: 'insert_step',
      op: 'insert_before',
      newStepId: 'healed_001',
      stepId: 'click_003',
    });
  });

  it('skips ids already in the workflow, at any depth', () => {
    const steps = [
      ...(workflow.steps as unknown as Loose[]),
      { ...dismiss, id: 'healed_001' },
      {
        id: 'guard_010',
        intent: 'Maybe.',
        action: 'guard',
        if: { selectorVisible: '#x' },
        then: [{ ...dismiss, id: 'healed_002' }],
      },
    ];
    const taken = { ...workflow, steps } as unknown as Workflow;
    expect(validateWorkflow(taken).valid).toBe(true);
    expect(promptFor(taken).newStepId).toBe('healed_003');
  });

  it('asks for a new step, not new selectors, in the user message', () => {
    const user = promptFor().messages[1]!.content;
    expect(user).toContain('Write one new step to run before the failed step');
    expect(user).not.toContain('Give the failed step new selectors');
  });
});

describe('parseHealResponse(): insert-step answers', () => {
  it('builds an insert_before patch with the id the healer chose', () => {
    const prompt = promptFor();
    const result = parseHealResponse(completion(answer(dismiss)), prompt);
    if (result.status !== 'patch') throw new Error(JSON.stringify(result));
    expect(result.patch).toMatchObject({
      workflowId: 'wf_portal_login',
      baseHash: hashWorkflow(workflow),
      stepId: 'click_003',
      op: 'insert_before',
      after: { ...dismiss, id: 'healed_001' },
      confidence: 0.8,
    });
    expect(result.patch).not.toHaveProperty('before');
  });

  it('replaces any id the model wrote, including the id of an existing step', () => {
    for (const id of ['click_003', 'goto_001', 'my_step', 42]) {
      const result = parseHealResponse(completion(answer({ ...dismiss, id })), promptFor());
      if (result.status !== 'patch') throw new Error(JSON.stringify(result));
      expect((result.patch.after as Loose).id).toBe('healed_001');
    }
  });

  it.each<[string, string, string]>([
    ['the selector answer form', JSON.stringify({ after: dismiss, rationale: 'x' }), 'wrong_shape'],
    ['a step that is not an object', answer('click the banner'), 'wrong_shape'],
    ['an array of steps', answer([dismiss, waitForPanel]), 'wrong_shape'],
    ['a key that sets the position', answer(dismiss, { op: 'insert_after' }), 'wrong_shape'],
    ['a key that sets the anchor', answer(dismiss, { stepId: 'goto_001' }), 'wrong_shape'],
    ['a step with no target', answer({ ...dismiss, target: undefined }), 'invalid_step'],
    ['a step with no intent', answer({ ...dismiss, intent: undefined }), 'invalid_step'],
  ])('rejects %s', (_name, content, code) => {
    expect(parseHealResponse(completion(content), promptFor())).toMatchObject({
      status: 'rejected',
      code,
    });
  });

  it('still returns cannot_heal', () => {
    const content = JSON.stringify({ cannotHeal: true, rationale: 'The page asks for a phone.' });
    expect(parseHealResponse(completion(content), promptFor())).toEqual({
      status: 'cannot_heal',
      rationale: 'The page asks for a phone.',
    });
  });

  it('refuses the insert form when the context is a replace', () => {
    const selector = buildHealPrompt({ workflow, failure, snapshot, redact: (t) => t });
    expect(parseHealResponse(completion(answer(dismiss)), selector)).toMatchObject({
      status: 'rejected',
      code: 'wrong_shape',
    });
  });

  it('throws when an insert context has no id for the new step', () => {
    const { newStepId: _dropped, ...broken } = promptFor();
    expect(() => parseHealResponse(completion(answer(dismiss)), broken)).toThrow(TypeError);
  });
});

describe('checkPatchClass(): limits on an inserted step', () => {
  const insert = (after: Loose): StepPatch => ({
    workflowId: workflow.id,
    baseHash: hashWorkflow(workflow),
    stepId: 'click_003',
    op: 'insert_before',
    after: { id: 'healed_001', ...after } as unknown as Step,
    rationale: 'test',
  });
  const found = (after: Loose) => {
    const result = checkPatchClass(insert(after), workflow, 'insert_step');
    return result.ok ? [] : result.violations.map((v) => [v.code, v.path]);
  };

  it('accepts a click and a wait for a condition', () => {
    expect(found(dismiss)).toEqual([]);
    expect(found(waitForPanel)).toEqual([]);
    expect(found({ ...waitForPanel, timeoutMs: INSERTED_STEP_MAX_TIMEOUT_MS })).toEqual([]);
  });

  it('rejects a fixed pause, with or without a condition', () => {
    expect(found({ ...waitForPanel, millis: 500 })).toEqual([['fixed_wait', '/after/millis']]);
    expect(found({ intent: 'Pause.', action: 'wait', millis: 3_600_000 })).toEqual([
      ['fixed_wait', '/after/millis'],
      ['fixed_wait', '/after/forCondition'],
    ]);
  });

  it('rejects a wait with neither a condition nor a pause', () => {
    expect(found({ intent: 'Wait.', action: 'wait' })).toEqual([
      ['fixed_wait', '/after/forCondition'],
    ]);
  });

  it('rejects a timeout above the limit on either action', () => {
    expect(INSERTED_STEP_MAX_TIMEOUT_MS).toBe(60_000);
    for (const step of [dismiss, waitForPanel]) {
      expect(found({ ...step, timeoutMs: 60_001 })).toEqual([
        ['timeout_too_long', '/after/timeoutMs'],
      ]);
    }
  });

  it('does not apply these limits to a selector patch', () => {
    const current = (workflow.steps as unknown as Loose[])[2]!;
    const patch: StepPatch = {
      ...insert({}),
      op: 'replace',
      before: current as unknown as Step,
      after: { ...current, target: dismiss.target } as unknown as Step,
    };
    expect(checkPatchClass(patch, workflow, 'selector')).toEqual({ ok: true });
  });
});

describe('generateInsertStepPatch()', () => {
  it('returns an insert patch that passes every check and applies before the failed step', async () => {
    const provider = fakeProvider(answer(dismiss));
    const result = await generateInsertStepPatch(input(provider));
    const patch = patchOf(result);

    expect(patch).toMatchObject({ op: 'insert_before', stepId: 'click_003' });
    expect(checkPatch(patch, workflow, 'insert_step')).toEqual({ status: 'ok' });

    const applied = applyPatch(workflow, patch);
    if (!applied.ok) throw new Error(JSON.stringify(applied.errors));
    expect((applied.workflow.steps as unknown as Loose[]).map((s) => s.id)).toEqual([
      'goto_001',
      'fill_002',
      'healed_001',
      'click_003',
    ]);
    expect(validateWorkflow(applied.workflow).valid).toBe(true);
  });

  it('sends the insert-step instructions, once, with a timeout and an output cap', async () => {
    const provider = fakeProvider(answer(dismiss));
    await generateInsertStepPatch(input(provider));
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.messages[0]!.content).toBe(INSERT_STEP_SYSTEM_PROMPT);
    expect(provider.calls[0]!.options).toEqual({ maxTokens: 2000, timeoutMs: 60000 });
  });

  it('puts the candidates of an inserted click in preference order', async () => {
    const patch = patchOf(await generateInsertStepPatch(input(fakeProvider(answer(dismiss)))));
    expect((patch.after as unknown as typeof dismiss).target.candidates).toEqual([
      { kind: 'role', value: "button[name='Reject all']" },
      { kind: 'css', value: 'dialog button.reject' },
    ]);
  });

  it('accepts a wait for a condition', async () => {
    const result = await generateInsertStepPatch(input(fakeProvider(answer(waitForPanel))));
    expect(patchOf(result).after).toMatchObject({ id: 'healed_001', action: 'wait' });
  });

  it('works for a failed step that has no target', async () => {
    const provider = fakeProvider(answer(waitForPanel));
    const result = await generateInsertStepPatch(
      input(provider, { failure: { ...failure, stepId: 'goto_001', action: 'navigate' } }),
    );
    expect(patchOf(result)).toMatchObject({ op: 'insert_before', stepId: 'goto_001' });
  });

  const phone = {
    intent: 'Enter the delivery phone number the page now asks for.',
    action: 'fill',
    target: { candidates: [{ kind: 'label', value: 'Delivery phone' }] },
    value: '0400 000 000',
  };

  it.each<[string, Loose, string, string]>([
    ['a fill', phone, 'class', 'action_not_allowed'],
    [
      'a navigate to another site',
      { intent: 'Go to the new login page.', action: 'navigate', url: 'https://evil.test/login' },
      'reach',
      'new_origin',
    ],
    [
      'a secret typed into a new field',
      { ...phone, value: { secret: 'portal_pass' } },
      'reach',
      'secret_added',
    ],
    ['a fixed pause', { intent: 'Pause.', action: 'wait', millis: 5000 }, 'class', 'fixed_wait'],
    [
      'a guard that carries steps',
      {
        intent: 'Dismiss the dialog if shown.',
        action: 'guard',
        if: { selectorVisible: 'dialog' },
        then: [{ ...dismiss, id: 'click_900' }],
      },
      'scope',
      'nested_steps_added',
    ],
    [
      'a catastrophic URL pattern',
      { ...waitForPanel, forCondition: { urlMatches: '(a+)+$' } },
      'pattern',
      'pattern_nested_quantifier',
    ],
    ['an unknown field', { ...dismiss, script: 'alert(1)' }, 'scope', 'unknown_field'],
  ])('rejects %s at the policy stage', async (_name, step, check, code) => {
    const result = await generateInsertStepPatch(input(fakeProvider(answer(step))));
    if (result.status !== 'rejected' || result.stage !== 'policy') {
      throw new Error(`expected a policy rejection, got ${JSON.stringify(result)}`);
    }
    expect(result.violations.map((v) => `${v.check}:${v.code}`)).toContain(`${check}:${code}`);
  });

  it('rejects a visual candidate and a cut-off answer before the policy stage', async () => {
    const visual = { ...dismiss, target: { candidates: [{ kind: 'visual', value: 'emb_1' }] } };
    expect(await generateInsertStepPatch(input(fakeProvider(answer(visual))))).toMatchObject({
      status: 'rejected',
      stage: 'candidates',
      code: 'visual_candidate',
    });
    const cutOff = fakeProvider({ content: answer(dismiss), stopReason: 'max_tokens' });
    expect(await generateInsertStepPatch(input(cutOff))).toMatchObject({
      status: 'rejected',
      stage: 'response',
      code: 'truncated',
    });
  });

  it('returns cannot_heal when the model says one step will not do', async () => {
    const provider = fakeProvider(
      JSON.stringify({ cannotHeal: true, rationale: 'The form now needs a phone number.' }),
    );
    expect(await generateInsertStepPatch(input(provider))).toMatchObject({
      status: 'cannot_heal',
      rationale: 'The form now needs a phone number.',
    });
  });

  it('makes no call when the failure names no step', async () => {
    const provider = fakeProvider(answer(dismiss));
    const result = await generateInsertStepPatch(
      input(provider, { failure: { ...failure, stepId: undefined } }),
    );
    expect(result).toMatchObject({ status: 'rejected', stage: 'input', code: 'no_step_id' });
    expect(provider.calls).toHaveLength(0);
  });
});
