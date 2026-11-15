// Rules enforced by validate.ts on top of the JSON Schema: no control
// characters in free text, unique step ids, and declared secret and
// parameter references.

import { describe, it, expect } from 'vitest';
import { validateWorkflow, validateStep, isWorkflow, isStep } from '../src/index.js';

const LINE_SEPARATOR = String.fromCharCode(0x2028);

function workflow(steps: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { irVersion: '1.0.0', id: 'wf_semantic', name: 'Semantic rules', steps, ...extra };
}

function navigate(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, intent: 'Open the page.', action: 'navigate', url: 'https://example.com', ...extra };
}

function click(id: string): Record<string, unknown> {
  return {
    id,
    intent: 'Click the button.',
    action: 'click',
    target: { candidates: [{ kind: 'role', value: 'button' }] },
  };
}

describe('validateWorkflow: control characters in free text', () => {
  it.each([
    ['newline', '\n'],
    ['carriage return', '\r'],
    ['tab', '\t'],
    ['null byte', '\0'],
    ['delete', String.fromCharCode(0x7f)],
  ])('rejects a %s in a step intent', (_label, ch) => {
    const result = validateWorkflow(workflow([navigate('step_one', { intent: `Open${ch}page` })]));
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({ path: '/steps/0/intent', keyword: 'controlCharacter' }),
    ]);
  });

  it('rejects a newline in the workflow name', () => {
    const result = validateWorkflow(workflow([navigate('step_one')], { name: 'Bad\nname' }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({ path: '/name', keyword: 'controlCharacter' });
  });

  it('rejects a newline in the workflow description', () => {
    const result = validateWorkflow(
      workflow([navigate('step_one')], { description: 'line one\nline two' }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({ path: '/description', keyword: 'controlCharacter' });
  });

  it('rejects a newline in the intent of a step nested in a guard', () => {
    const guard = {
      id: 'guard_one',
      intent: 'Dismiss the banner if present.',
      action: 'guard',
      if: { selectorVisible: '#banner' },
      then: [{ ...click('inner_click'), intent: 'Click\nAccept' }],
    };
    const result = validateWorkflow(workflow([guard]));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      path: '/steps/0/then/0/intent',
      keyword: 'controlCharacter',
    });
  });

  it('accepts ordinary punctuation and non-ASCII text', () => {
    const result = validateWorkflow(
      workflow([navigate('step_one', { intent: "Ouvrir la page d'accueil: café, 日本語." })]),
    );
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('leaves Unicode line separators to the compiler, which strips them from comments', () => {
    const result = validateWorkflow(
      workflow([navigate('step_one', { intent: `Open${LINE_SEPARATOR}page` })]),
    );
    expect(result.valid).toBe(true);
  });
});

describe('validateWorkflow: unique step ids', () => {
  it('rejects two top-level steps with the same id', () => {
    const result = validateWorkflow(workflow([navigate('same_id'), click('same_id')]));
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        path: '/steps/1/id',
        keyword: 'uniqueStepId',
        params: { id: 'same_id', firstSeenAt: '/steps/0' },
      }),
    ]);
  });

  it('rejects a nested step that reuses a top-level id', () => {
    const loop = {
      id: 'loop_one',
      intent: 'Visit each row.',
      action: 'loop',
      foreach: { candidates: [{ kind: 'css', value: 'tr' }] },
      do: [click('step_one')],
    };
    const result = validateWorkflow(workflow([navigate('step_one'), loop]));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({ path: '/steps/1/do/0/id', keyword: 'uniqueStepId' });
  });

  it('rejects duplicates across the then and else branches of a guard', () => {
    const guard = {
      id: 'guard_one',
      intent: 'Branch on the banner.',
      action: 'guard',
      if: { selectorVisible: '#banner' },
      then: [click('branch_step')],
      else: [click('branch_step')],
    };
    const result = validateWorkflow(workflow([guard]));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({ path: '/steps/0/else/0/id', keyword: 'uniqueStepId' });
  });
});

describe('validateWorkflow: declared references', () => {
  const fill = (value: unknown): Record<string, unknown> => ({
    id: 'fill_one',
    intent: 'Fill the field.',
    action: 'fill',
    target: { candidates: [{ kind: 'label', value: 'Password' }] },
    value,
  });

  it('rejects a secret that is not listed in workflow.secrets', () => {
    const result = validateWorkflow(workflow([fill({ secret: 'portal_password' })]));
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        path: '/steps/0/value/secret',
        keyword: 'undeclaredSecret',
        params: { secret: 'portal_password' },
      }),
    ]);
  });

  it('accepts a secret that is listed in workflow.secrets', () => {
    const result = validateWorkflow(
      workflow([fill({ secret: 'portal_password' })], { secrets: ['portal_password'] }),
    );
    expect(result.errors).toEqual([]);
  });

  it('rejects a parameter that is not declared in workflow.parameters', () => {
    const result = validateWorkflow(
      workflow([navigate('step_one', { url: { param: 'startUrl' } })]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      path: '/steps/0/url/param',
      keyword: 'undeclaredParam',
    });
  });

  it('accepts a declared parameter', () => {
    const result = validateWorkflow(
      workflow([navigate('step_one', { url: { param: 'startUrl' } })], {
        parameters: { startUrl: { type: 'string' } },
      }),
    );
    expect(result.errors).toEqual([]);
  });

  it('checks references inside nested bodies', () => {
    const guard = {
      id: 'guard_one',
      intent: 'Log in if asked.',
      action: 'guard',
      if: { selectorVisible: '#login' },
      then: [fill({ secret: 'nested_secret' })],
    };
    const result = validateWorkflow(workflow([guard]));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      path: '/steps/0/then/0/value/secret',
      keyword: 'undeclaredSecret',
    });
  });
});

describe('validateStep and the type guards share the semantic rules', () => {
  it('validateStep rejects a control character in intent', () => {
    const result = validateStep(navigate('step_one', { intent: 'Open\npage' }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({ path: '/intent', keyword: 'controlCharacter' });
  });

  it('validateStep rejects duplicate ids inside one step', () => {
    const loop = {
      id: 'loop_one',
      intent: 'Visit each row.',
      action: 'loop',
      foreach: { candidates: [{ kind: 'css', value: 'tr' }] },
      do: [click('loop_one')],
    };
    const result = validateStep(loop);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({ path: '/do/0/id', keyword: 'uniqueStepId' });
  });

  it('validateStep does not check declarations, which live on the workflow', () => {
    const result = validateStep(navigate('step_one', { url: { param: 'anything' } }));
    expect(result.valid).toBe(true);
  });

  it('isWorkflow and isStep return false for semantic failures', () => {
    expect(isWorkflow(workflow([navigate('same_id'), click('same_id')]))).toBe(false);
    expect(isStep(navigate('step_one', { intent: 'Open\npage' }))).toBe(false);
  });
});
