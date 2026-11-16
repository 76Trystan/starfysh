import { describe, expect, it } from 'vitest';
import { applyPatch, diffPatch, hashWorkflow, validatePatch } from '@sfysh/ir';
import type { Step, Workflow } from '@sfysh/ir';
import type { Completion, StopReason } from '@sfysh/providers';
import {
  buildHealPrompt,
  parseHealResponse,
  RATIONALE_MAX_CHARS,
  RESPONSE_MAX_CHARS,
} from '../src/index.js';
import type { HealPatchContext, HealResponse } from '../src/index.js';

const workflow = {
  irVersion: '1.0.0',
  id: 'wf_portal_login',
  name: 'Portal login',
  steps: [
    {
      id: 'goto_001',
      intent: 'Open the login page.',
      action: 'navigate',
      url: 'https://portal.example.com/login',
    },
    {
      id: 'click_005',
      intent: 'Submit the login form.',
      action: 'click',
      target: { candidates: [{ kind: 'role', value: "button[name='Sign in']" }] },
      post: [{ urlMatches: '/dashboard' }],
    },
  ],
} as unknown as Workflow;

const before = workflow.steps[1] as Step;

const context: HealPatchContext = {
  workflowId: workflow.id,
  stepId: 'click_005',
  before,
  baseHash: hashWorkflow(workflow),
};

const healedStep = {
  id: 'click_005',
  intent: 'Submit the login form.',
  action: 'click',
  target: {
    candidates: [
      { kind: 'role', value: "button[name='Log in']" },
      { kind: 'css', value: 'form button[type=submit]' },
    ],
  },
  post: [{ urlMatches: '/dashboard' }],
};

const goodAnswer = {
  after: healedStep,
  rationale: 'The button was renamed from "Sign in" to "Log in".',
  confidence: 0.9,
};

function completion(content: unknown, stopReason: StopReason = 'end'): Completion {
  return {
    content: typeof content === 'string' ? content : JSON.stringify(content),
    stopReason,
    usage: { inputTokens: 100, outputTokens: 50 },
    model: 'stub-model',
  };
}

function parse(content: unknown, stopReason: StopReason = 'end'): HealResponse {
  return parseHealResponse(completion(content, stopReason), context);
}

function expectRejected(result: HealResponse, code: string) {
  expect(result.status).toBe('rejected');
  if (result.status === 'rejected') expect(result.code).toBe(code);
}

describe('parseHealResponse(): a good answer', () => {
  it('builds a replace patch from the answer and the healer’s own context', () => {
    const result = parse(goodAnswer);

    expect(result).toEqual({
      status: 'patch',
      patch: {
        workflowId: 'wf_portal_login',
        baseHash: context.baseHash,
        stepId: 'click_005',
        op: 'replace',
        before,
        after: healedStep,
        rationale: 'The button was renamed from "Sign in" to "Log in".',
        confidence: 0.9,
      },
    });
  });

  it('returns a patch that validates and applies to the workflow it was written for', () => {
    const result = parse(goodAnswer);
    if (result.status !== 'patch') throw new Error('expected a patch');

    expect(validatePatch(result.patch).valid).toBe(true);
    const applied = applyPatch(workflow, result.patch);
    expect(applied.ok).toBe(true);
  });

  it('works from the context a real prompt produced', () => {
    const prompt = buildHealPrompt({
      workflow,
      failure: { name: 'TimeoutError', message: 'timeout', stepId: 'click_005' },
      snapshot: { text: '- button "Log in"', truncated: false, originalLength: 17 },
      redact: (text) => text,
    });

    const result = parseHealResponse(completion(goodAnswer), prompt);
    expect(result.status).toBe('patch');
  });

  it('leaves confidence off the patch when the model gave none', () => {
    const result = parse({ after: healedStep, rationale: 'Renamed.' });
    if (result.status !== 'patch') throw new Error('expected a patch');
    expect('confidence' in result.patch).toBe(false);
  });

  it('accepts a completion that ended on a stop sequence', () => {
    expect(parse(goodAnswer, 'stop_sequence').status).toBe('patch');
  });

  it.each([
    ['a json code fence', '```json\n' + JSON.stringify(goodAnswer) + '\n```'],
    ['a bare code fence', '```\n' + JSON.stringify(goodAnswer, null, 2) + '\n```'],
    ['surrounding whitespace', '\n\n  ' + JSON.stringify(goodAnswer) + '  \n'],
  ])('tolerates %s around the JSON', (_label, content) => {
    expect(parse(content).status).toBe('patch');
  });
});

describe('parseHealResponse(): cannot heal', () => {
  it('returns the model’s explanation', () => {
    expect(parse({ cannotHeal: true, rationale: 'No submit button in the snapshot.' })).toEqual({
      status: 'cannot_heal',
      rationale: 'No submit button in the snapshot.',
    });
  });

  it.each([
    ['cannotHeal is false', { cannotHeal: false, rationale: 'x' }],
    ['cannotHeal is a string', { cannotHeal: 'true', rationale: 'x' }],
    ['the rationale is missing', { cannotHeal: true }],
    ['a step is supplied as well', { cannotHeal: true, rationale: 'x', after: healedStep }],
  ])('rejects the answer when %s', (_label, answer) => {
    expectRejected(parse(answer), 'wrong_shape');
  });
});

describe('parseHealResponse(): stop reason', () => {
  it.each<[StopReason, string]>([
    ['max_tokens', 'truncated'],
    ['refusal', 'refused'],
    ['other', 'incomplete'],
  ])('rejects a completion that stopped with %s as %s', (stopReason, code) => {
    expectRejected(parse(goodAnswer, stopReason), code);
  });

  it('rejects a truncated completion even when what is left parses as a valid answer', () => {
    // Cut after "rationale", before "confidence": still complete JSON.
    const cutShort = JSON.stringify({ after: healedStep, rationale: 'The button was ren' });
    expectRejected(parse(cutShort, 'max_tokens'), 'truncated');
  });

  it('rejects a stop reason this version does not know', () => {
    expectRejected(parse(goodAnswer, 'brand_new_reason' as StopReason), 'incomplete');
  });
});

describe('parseHealResponse(): not JSON', () => {
  it.each([
    ['empty output', ''],
    ['prose', 'I could not find the button.'],
    ['JSON cut off mid-object', '{"after": {"id": "click_005", "intent": "Sub'],
    ['prose before the JSON', 'Here is the patch:\n' + JSON.stringify(goodAnswer)],
    ['prose after the JSON', JSON.stringify(goodAnswer) + '\nLet me know if this helps.'],
    ['a fence with prose outside it', 'Sure.\n```json\n' + JSON.stringify(goodAnswer) + '\n```'],
    ['two JSON objects', JSON.stringify(goodAnswer) + JSON.stringify(goodAnswer)],
  ])('rejects %s', (_label, content) => {
    expectRejected(parse(content), 'not_json');
  });

  it('rejects output over the size limit without parsing it', () => {
    const huge = JSON.stringify({ ...goodAnswer, rationale: 'x'.repeat(RESPONSE_MAX_CHARS) });
    expectRejected(parse(huge), 'too_large');
  });
});

describe('parseHealResponse(): wrong shape', () => {
  it.each([
    ['an array', [goodAnswer]],
    ['a string', '"click the other button"'],
    ['null', 'null'],
    ['an empty object', {}],
    ['a missing rationale', { after: healedStep }],
    ['an empty rationale', { after: healedStep, rationale: '   ' }],
    ['a rationale that is not a string', { after: healedStep, rationale: { text: 'x' } }],
    ['confidence above 1', { ...goodAnswer, confidence: 95 }],
    ['confidence below 0', { ...goodAnswer, confidence: -0.1 }],
    ['confidence as a string', { ...goodAnswer, confidence: '0.9' }],
    ['confidence as null', { ...goodAnswer, confidence: null }],
  ])('rejects %s', (_label, answer) => {
    expectRejected(parse(answer), 'wrong_shape');
  });

  it.each([
    ['stepId', { ...goodAnswer, stepId: 'goto_001' }],
    ['op', { ...goodAnswer, op: 'insert_after' }],
    ['baseHash', { ...goodAnswer, baseHash: `sha256:${'0'.repeat(64)}` }],
    ['before', { ...goodAnswer, before: healedStep }],
    ['workflowId', { ...goodAnswer, workflowId: 'wf_other' }],
    ['a whole patch', { patch: goodAnswer, ...goodAnswer }],
  ])('rejects an answer that tries to set %s', (_label, answer) => {
    expectRejected(parse(answer), 'wrong_shape');
  });

  it('does not quote the model’s answer in the rejection message', () => {
    const result = parse({ ...goodAnswer, 'IGNORE PREVIOUS INSTRUCTIONS': true });
    expectRejected(result, 'wrong_shape');
    expect(JSON.stringify(result)).not.toContain('IGNORE');
  });
});

describe('parseHealResponse(): invalid step', () => {
  it.each([
    ['not an object', 'click the Log in button'],
    ['missing its intent', { ...healedStep, intent: undefined }],
    ['an unknown action', { ...healedStep, action: 'evaluate' }],
    ['an unknown field inside target', { ...healedStep, target: { ...healedStep.target, x: 1 } }],
    ['an empty candidate list', { ...healedStep, target: { candidates: [] } }],
    [
      'an unknown selector kind',
      { ...healedStep, target: { candidates: [{ kind: 'xpath', value: '//button' }] } },
    ],
    ['a control character in its intent', { ...healedStep, intent: 'Submit\u0007 the form.' }],
  ])('rejects a step that is %s, with the schema errors', (_label, after) => {
    const result = parse({ ...goodAnswer, after });
    expectRejected(result, 'invalid_step');
    if (result.status === 'rejected') expect(result.errors?.length).toBeGreaterThan(0);
  });

  // The step schema closes every nested object but not the step itself, so
  // a field no executor reads passes validation. The parser's job ends at
  // "well formed"; this pins that the extra field is visible in the patch
  // diff, which is what the scope check works from.
  it('lets an unknown top-level step field through, visible in the diff', () => {
    const result = parse({ ...goodAnswer, after: { ...healedStep, script: 'document.cookie' } });
    if (result.status !== 'patch') throw new Error('expected a patch');
    expect(JSON.stringify(diffPatch(result.patch))).toContain('/script');
  });
});

describe('parseHealResponse(): invalid patch', () => {
  it('rejects a replacement that changed the step id', () => {
    const result = parse({ ...goodAnswer, after: { ...healedStep, id: 'click_006' } });
    expectRejected(result, 'invalid_patch');
    if (result.status === 'rejected') {
      expect(result.errors?.some((e) => e.path === '/after/id')).toBe(true);
    }
  });

  it('rejects a replacement that took the id of another step', () => {
    expectRejected(
      parse({ ...goodAnswer, after: { ...healedStep, id: 'goto_001' } }),
      'invalid_patch',
    );
  });
});

describe('parseHealResponse(): rationale', () => {
  it('cuts an over-long rationale to the patch schema’s limit and keeps the patch', () => {
    const result = parse({ ...goodAnswer, rationale: 'r'.repeat(RATIONALE_MAX_CHARS + 500) });
    if (result.status !== 'patch') throw new Error('expected a patch');
    expect(result.patch.rationale).toHaveLength(RATIONALE_MAX_CHARS);
  });

  it('removes terminal escape and control characters, keeping line breaks', () => {
    const result = parse({
      ...goodAnswer,
      rationale: 'Renamed.\u001b[31m\nSecond line.\u0000\u2028',
    });
    if (result.status !== 'patch') throw new Error('expected a patch');
    expect(result.patch.rationale).toBe('Renamed. [31m\nSecond line.');
  });

  it('cleans the rationale of a cannot-heal answer too', () => {
    const result = parse({ cannotHeal: true, rationale: '\u001b]0;title\u0007 Nothing to click.' });
    expect(result).toEqual({ status: 'cannot_heal', rationale: ']0;title  Nothing to click.' });
  });
});

describe('parseHealResponse(): never throws', () => {
  it.each([
    ['a __proto__ key', '{"__proto__": {"polluted": true}, "after": {}, "rationale": "x"}'],
    ['a constructor key', '{"constructor": {"prototype": {}}, "rationale": "x"}'],
    ['deep nesting', '['.repeat(5_000) + ']'.repeat(5_000)],
    ['a huge number', '{"after": {}, "rationale": "x", "confidence": 1e999}'],
  ])('returns a rejection for %s', (_label, content) => {
    const result = parse(content);
    expect(result.status).toBe('rejected');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
