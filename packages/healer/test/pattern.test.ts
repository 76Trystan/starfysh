import { describe, expect, it } from 'vitest';
import { hashWorkflow, validateWorkflow } from '@sfysh/ir';
import type { Step, StepPatch, Workflow } from '@sfysh/ir';
import {
  checkPatchPatterns,
  checkUrlPattern,
  URL_PATTERN_MAX_CHARS,
  URL_PATTERN_MAX_UNBOUNDED,
} from '../src/index.js';
import type { PatternResult } from '../src/index.js';

describe('checkUrlPattern(): patterns within the limits', () => {
  it.each([
    '/dashboard',
    '/orders?month=2026-10',
    '^https://app\\.example\\.com/orders/\\d+$',
    '^https://(app|www)\\.example\\.com/',
    '/orders/\\d+/items/\\d+/lines/\\d+',
    '/orders/[0-9a-f]{8}(-[0-9a-f]{4}){3}',
    '/(en|fr|de)/home',
    '/reports(/summary)?$',
    '(/[a-z]{2})?/home',
    '^https?://app\\.example\\.com',
    '/search\\?q=.+&page=\\d{1,3}$',
    '/files/.*\\.pdf$',
    '/a{2,5}/b+?/c*?',
    '/items/[^/]+/edit',
    '[(+*]+/x',
    '\\(\\d+\\)+',
    '(?:/v\\d)?/api',
    '(?<lang>en|fr)/docs',
    '',
  ])('accepts %s', (pattern) => {
    expect(checkUrlPattern(pattern)).toBeUndefined();
  });
});

describe('checkUrlPattern(): nested quantifiers', () => {
  it.each([
    '(a+)+$',
    '(a*)*',
    '(a+)*b',
    '(.*a){20}',
    '(\\d+)+$',
    '([a-z]+)*$',
    '(a|b+)+',
    '((a+)b)+',
    '(?:a+)+',
    '(a+){2,}',
    '(a+){1,3}',
    '(a?){5}',
    '(a{1,5})+',
    '(a+)+?',
    '(x(y*)z)*',
    '^(/[a-z]+)*$',
  ])('rejects %s', (pattern) => {
    expect(checkUrlPattern(pattern)).toBe('nested_quantifier');
  });

  it('accepts a repeated group whose contents have a fixed length', () => {
    expect(checkUrlPattern('(/[a-z]{2})+')).toBeUndefined();
    expect(checkUrlPattern('(ab|cd){3}')).toBeUndefined();
  });

  it('accepts a variable group that is not repeated', () => {
    expect(checkUrlPattern('(a+)(b*)')).toBeUndefined();
    expect(checkUrlPattern('(a+)?')).toBeUndefined();
    expect(checkUrlPattern('(a+){1}')).toBeUndefined();
  });

  it('does not read escaped or bracketed characters as structure', () => {
    expect(checkUrlPattern('\\(a+\\)+')).toBeUndefined();
    expect(checkUrlPattern('[(]a+[)]+')).toBeUndefined();
    expect(checkUrlPattern('[\\]]+(a)+')).toBeUndefined();
  });

  it('finishes quickly on the pattern it was written to stop', () => {
    // Sanity check on the premise: this pattern is the audit's example.
    const start = Date.now();
    expect(checkUrlPattern('(a+)+$')).toBe('nested_quantifier');
    expect(Date.now() - start).toBeLessThan(100);
  });
});

describe('checkUrlPattern(): other limits', () => {
  it('rejects a pattern over the length cap and accepts one at it', () => {
    expect(URL_PATTERN_MAX_CHARS).toBe(200);
    expect(checkUrlPattern('a'.repeat(URL_PATTERN_MAX_CHARS))).toBeUndefined();
    expect(checkUrlPattern('a'.repeat(URL_PATTERN_MAX_CHARS + 1))).toBe('too_long');
  });

  it.each(['/a(b', '[z-a]', 'a{2,1}', '*start', '(?<n>a)(?<n>b)\\k<m>('])(
    'rejects %s, which does not compile',
    (pattern) => {
      expect(checkUrlPattern(pattern)).toBe('invalid');
    },
  );

  it('rejects more unbounded quantifiers than the cap', () => {
    expect(URL_PATTERN_MAX_UNBOUNDED).toBe(3);
    expect(checkUrlPattern('.*a.*b.*c')).toBeUndefined();
    expect(checkUrlPattern('.*.*.*.*x')).toBe('too_many_quantifiers');
    expect(checkUrlPattern('\\d+/\\d+/\\d+/\\d+')).toBe('too_many_quantifiers');
    expect(checkUrlPattern('a{2,}b{3,}c{4,}d{5,}')).toBe('too_many_quantifiers');
  });

  it('does not count bounded or optional parts towards the cap', () => {
    expect(checkUrlPattern('a?b?c?d?e?f{1,3}g{2}h{0,9}')).toBeUndefined();
  });
});

const workflow = {
  irVersion: '1.0.0',
  id: 'wf_orders',
  name: 'Order export',
  steps: [
    {
      id: 'click_001',
      intent: 'Submit the login form.',
      action: 'click',
      target: { candidates: [{ kind: 'role', value: "button[name='Sign in']" }] },
      // Written by a person before these limits existed.
      post: [{ urlMatches: '^(/[a-z]+)*/dashboard$' }],
    },
    {
      id: 'guard_002',
      intent: 'Dismiss the banner if it is shown.',
      action: 'guard',
      if: { selectorVisible: '#banner' },
      then: [
        {
          id: 'click_003',
          intent: 'Close the banner.',
          action: 'click',
          target: { candidates: [{ kind: 'css', value: '#banner button' }] },
        },
      ],
    },
  ],
} as unknown as Workflow;

type Loose = Record<string, unknown>;
const first = (workflow.steps as unknown as Loose[])[0]!;
const BAD = '(a+)+$';

function replace(changes: Loose): StepPatch {
  return {
    workflowId: workflow.id,
    baseHash: hashWorkflow(workflow),
    stepId: 'click_001',
    op: 'replace',
    before: first as unknown as Step,
    after: { ...first, ...changes } as unknown as Step,
    rationale: 'test',
  };
}

function insert(after: Loose): StepPatch {
  return {
    workflowId: workflow.id,
    baseHash: hashWorkflow(workflow),
    stepId: 'click_001',
    op: 'insert_after',
    after: after as unknown as Step,
    rationale: 'test',
  };
}

function found(result: PatternResult): Array<[string, string]> {
  return result.ok ? [] : result.violations.map((v) => [v.code, v.path]);
}

describe('checkPatchPatterns()', () => {
  it('has a valid fixture', () => {
    expect(validateWorkflow(workflow).valid).toBe(true);
  });

  it('accepts a patch with no URL pattern', () => {
    const patch = replace({ target: { candidates: [{ kind: 'css', value: 'button' }] } });
    expect(checkPatchPatterns(patch, workflow)).toEqual({ ok: true });
  });

  it('leaves a pattern that is already in the workflow alone', () => {
    const existing = '^(/[a-z]+)*/dashboard$';
    expect(checkUrlPattern(existing)).toBe('nested_quantifier');
    expect(checkPatchPatterns(replace({}), workflow)).toEqual({ ok: true });
    // The same pattern reused on another step is still the approved one.
    const wait = {
      id: 'wait_900',
      intent: 'Wait for the dashboard.',
      action: 'wait',
      forCondition: { urlMatches: existing },
    };
    expect(checkPatchPatterns(insert(wait), workflow)).toEqual({ ok: true });
  });

  it('accepts a new pattern within the limits', () => {
    const patch = replace({ pre: [{ urlMatches: '/login(\\?next=.*)?$' }] });
    expect(checkPatchPatterns(patch, workflow)).toEqual({ ok: true });
  });

  it.each<[string, string]>([
    [BAD, 'pattern_nested_quantifier'],
    ['x'.repeat(201), 'pattern_too_long'],
    ['/a(b', 'pattern_invalid'],
    ['.*.*.*.*x', 'pattern_too_many_quantifiers'],
  ])('rejects the new pattern %s', (pattern, code) => {
    const patch = replace({ pre: [{ urlMatches: pattern }] });
    expect(found(checkPatchPatterns(patch, workflow))).toEqual([[code, '/after/pre/0/urlMatches']]);
  });

  it('rejects an existing pattern that was edited, however slightly', () => {
    const patch = replace({ post: [{ urlMatches: '^(/[a-z]+)*/dashboard/?$' }] });
    expect(found(checkPatchPatterns(patch, workflow))).toEqual([
      ['pattern_nested_quantifier', '/after/post/0/urlMatches'],
    ]);
  });

  it('checks every place a condition can sit, and nested steps', () => {
    const bad = { urlMatches: BAD };
    const click = { ...first, id: 'click_901', post: undefined };
    const cases: Array<[Loose, string]> = [
      [{ ...click, pre: [{ textPresent: 'x' }, bad] }, '/after/pre/1/urlMatches'],
      [{ ...click, post: [bad] }, '/after/post/0/urlMatches'],
      [
        { id: 'wait_900', intent: 'Wait.', action: 'wait', forCondition: bad },
        '/after/forCondition/urlMatches',
      ],
      [
        { id: 'assert_900', intent: 'Check.', action: 'assert', condition: bad },
        '/after/condition/urlMatches',
      ],
      [
        { id: 'guard_900', intent: 'Maybe.', action: 'guard', if: bad, then: [click] },
        '/after/if/urlMatches',
      ],
      [
        { id: 'loop_900', intent: 'Repeat.', action: 'loop', while: bad, do: [click] },
        '/after/while/urlMatches',
      ],
      [
        {
          id: 'guard_900',
          intent: 'Maybe.',
          action: 'guard',
          if: { textPresent: 'x' },
          then: [{ ...click, pre: [bad] }],
        },
        '/after/then/0/pre/0/urlMatches',
      ],
    ];
    for (const [step, path] of cases) {
      expect(found(checkPatchPatterns(insert(step), workflow))).toEqual([
        ['pattern_nested_quantifier', path],
      ]);
    }
  });

  it('reports every bad pattern and does not quote any of them', () => {
    const patch = replace({
      pre: [{ urlMatches: 'SENTINEL(a+)+' }, { urlMatches: 'SENTINEL(' }],
    });
    const result = checkPatchPatterns(patch, workflow);
    expect(found(result)).toEqual([
      ['pattern_nested_quantifier', '/after/pre/0/urlMatches'],
      ['pattern_invalid', '/after/pre/1/urlMatches'],
    ]);
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
  });

  it('ignores patterns in other kinds of condition', () => {
    const patch = replace({ pre: [{ textPresent: BAD }, { selectorVisible: BAD }] });
    expect(checkPatchPatterns(patch, workflow)).toEqual({ ok: true });
  });
});
