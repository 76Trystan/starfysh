import { describe, expect, it } from 'vitest';
import { hashWorkflow, validateWorkflow } from '@sfysh/ir';
import type { Step, StepPatch, Workflow } from '@sfysh/ir';
import { checkPatchClass, checkPatchReach, checkPatchScope } from '../src/index.js';
import type { ReachResult } from '../src/index.js';

const workflow = {
  irVersion: '1.0.0',
  id: 'wf_orders',
  name: 'Order export',
  secrets: ['portal_user', 'portal_pass'],
  steps: [
    {
      id: 'goto_001',
      intent: 'Open the login page.',
      action: 'navigate',
      url: 'https://app.example.com/login',
      post: [{ urlEquals: 'https://app.example.com/login' }],
    },
    {
      id: 'fill_002',
      intent: 'Enter the account password.',
      action: 'fill',
      target: { candidates: [{ kind: 'role', value: "textbox[name='Password']" }] },
      value: { secret: 'portal_pass' },
    },
    {
      id: 'fill_003',
      intent: 'Enter the month to export.',
      action: 'fill',
      target: { candidates: [{ kind: 'label', value: 'Month' }] },
      value: '2026-10',
    },
    {
      id: 'click_004',
      intent: 'Submit the login form.',
      action: 'click',
      target: { candidates: [{ kind: 'role', value: "button[name='Sign in']" }] },
      post: [{ urlMatches: '^https://(app|www)\\.example\\.com/dashboard' }],
    },
    {
      id: 'guard_005',
      intent: 'Sign in again if the session page is shown.',
      action: 'guard',
      if: { urlMatches: 'https:\\/\\/sso\\.example\\.com\\/' },
      then: [
        {
          id: 'fill_006',
          intent: 'Enter the password on the session page.',
          action: 'fill',
          target: { candidates: [{ kind: 'css', value: '#pw' }] },
          value: { secret: 'portal_pass' },
        },
      ],
    },
    {
      id: 'goto_007',
      intent: 'Open the orders page.',
      action: 'navigate',
      url: '/orders',
    },
  ],
} as unknown as Workflow;

type Loose = Record<string, unknown>;

function stepOf(id: string): Loose {
  const find = (steps: Loose[]): Loose | undefined => {
    for (const step of steps) {
      if (step.id === id) return step;
      const found = find((step.then as Loose[] | undefined) ?? []);
      if (found) return found;
    }
    return undefined;
  };
  const found = find(workflow.steps as unknown as Loose[]);
  if (!found) throw new Error(`no step ${id}`);
  return found;
}

/** A replace patch for `id` whose `after` is the current step with `changes` applied. */
function replace(id: string, changes: Loose): StepPatch {
  const before = stepOf(id);
  const after: Loose = { ...before, ...changes };
  for (const key of Object.keys(after)) if (after[key] === undefined) delete after[key];
  return {
    workflowId: workflow.id,
    baseHash: hashWorkflow(workflow),
    stepId: id,
    op: 'replace',
    before: before as unknown as Step,
    after: after as unknown as Step,
    rationale: 'test',
  };
}

function insert(after: Loose): StepPatch {
  return {
    workflowId: workflow.id,
    baseHash: hashWorkflow(workflow),
    stepId: 'click_004',
    op: 'insert_before',
    after: after as unknown as Step,
    rationale: 'test',
  };
}

function found(result: ReachResult): Array<[string, string]> {
  if (result.status === 'rejected') return result.violations.map((v) => [v.code, v.path]);
  if (result.status === 'needs_approval') return result.approvals.map((a) => [a.code, a.path]);
  return [];
}

const newTarget = { target: { candidates: [{ kind: 'role', value: "button[name='Log in']" }] } };

const wait = (forCondition: Loose) => ({
  id: 'wait_900',
  intent: 'Wait for the page to settle.',
  action: 'wait',
  forCondition,
});

describe('checkPatchReach(): the fixture', () => {
  it('is a valid workflow', () => {
    expect(validateWorkflow(workflow).valid).toBe(true);
  });
});

describe('checkPatchReach(): origins in navigate URLs', () => {
  it.each([
    ['the same URL', 'https://app.example.com/login'],
    ['another path on a known origin', 'https://app.example.com/signin?next=%2Forders'],
    ['a known origin in other casing', 'HTTPS://APP.EXAMPLE.COM/login'],
    ['a relative path', '/signin'],
    ['a relative path with no leading slash', 'signin'],
  ])('accepts %s', (_name, url) => {
    expect(checkPatchReach(replace('goto_001', { url }), workflow)).toEqual({ status: 'ok' });
  });

  it.each([
    ['another site', 'https://evil.test/login'],
    ['a subdomain of a known host', 'https://login.app.example.com/'],
    ['a known host as a prefix', 'https://app.example.com.evil.test/login'],
    ['a known host as userinfo', 'https://app.example.com@evil.test/login'],
    ['another port', 'https://app.example.com:8443/login'],
    ['http in place of https', 'http://app.example.com/login'],
    ['a protocol-relative URL', '//evil.test/login'],
    ['a protocol-relative URL to a known host', '//app.example.com/login'],
    ['a backslash host', '/\\evil.test/login'],
    ['leading whitespace before a host', '\t//evil.test/login'],
    ['a javascript URL', 'javascript:fetch("https://app.example.com/")'],
    ['a data URL', 'data:text/html,<form action="https://app.example.com/">'],
    ['a file URL', 'file:///etc/passwd'],
    ['an https URL with no slashes', 'https:evil'],
    ['an unparseable URL', 'https://exa mple.com/'],
  ])('rejects %s', (_name, url) => {
    expect(found(checkPatchReach(replace('goto_001', { url }), workflow))).toEqual([
      ['new_origin', '/after/url'],
    ]);
  });

  it('rejects an inserted navigate to another site and accepts one to a known origin', () => {
    const goto = (url: string) => ({ id: 'goto_900', intent: 'Go.', action: 'navigate', url });
    expect(found(checkPatchReach(insert(goto('https://evil.test/')), workflow))).toEqual([
      ['new_origin', '/after/url'],
    ]);
    expect(checkPatchReach(insert(goto('https://app.example.com/x')), workflow)).toEqual({
      status: 'ok',
    });
  });

  it('knows no origin when the workflow has none', () => {
    const bare = {
      ...workflow,
      steps: [{ id: 'goto_001', intent: 'Open.', action: 'navigate', url: { param: 'start' } }],
      parameters: { start: { type: 'string' } },
      secrets: [],
    } as unknown as Workflow;
    const patch: StepPatch = {
      workflowId: bare.id,
      baseHash: hashWorkflow(bare),
      stepId: 'goto_001',
      op: 'insert_after',
      after: wait({ urlEquals: 'https://app.example.com/' }) as unknown as Step,
      rationale: 'test',
    };
    expect(found(checkPatchReach(patch, bare))).toEqual([
      ['new_origin', '/after/forCondition/urlEquals'],
    ]);
  });
});

describe('checkPatchReach(): origins in URL conditions', () => {
  it.each<[string, Loose]>([
    ['urlEquals on a known origin', { urlEquals: 'https://app.example.com/dashboard' }],
    ['urlMatches with a path only', { urlMatches: '/dashboard(/home)?$' }],
    ['urlMatches on a known origin', { urlMatches: '^https://app\\.example\\.com/home' }],
    ['urlMatches on a known origin, anchored', { urlMatches: '^https://app.example.com$' }],
    ['urlMatches on an origin known from a pattern', { urlMatches: 'https://sso.example.com/x' }],
    [
      'a pattern host copied from the workflow',
      { urlMatches: '^https://(app|www)\\.example\\.com/home' },
    ],
    ['a condition that is not about the URL', { textPresent: 'https://evil.test/' }],
  ])('accepts %s', (_name, condition) => {
    expect(checkPatchReach(insert(wait(condition)), workflow)).toEqual({ status: 'ok' });
  });

  it.each<[string, Loose, string]>([
    ['urlEquals on another site', { urlEquals: 'https://evil.test/dashboard' }, 'urlEquals'],
    ['urlMatches on another site', { urlMatches: 'https://evil.test/' }, 'urlMatches'],
    ['an escaped pattern', { urlMatches: '^https:\\/\\/evil\\.test\\/' }, 'urlMatches'],
    ['a wildcard host', { urlMatches: '^https://.*/dashboard' }, 'urlMatches'],
    ['a wider alternation', { urlMatches: '^https://(app|evil)\\.example\\.com/' }, 'urlMatches'],
    [
      'a known host as userinfo',
      { urlMatches: 'https://app.example.com@evil.test/' },
      'urlMatches',
    ],
    ['http in place of https', { urlMatches: 'http://app.example.com/' }, 'urlMatches'],
  ])('rejects %s', (_name, condition, key) => {
    expect(found(checkPatchReach(insert(wait(condition)), workflow))).toEqual([
      ['new_origin', `/after/forCondition/${key}`],
    ]);
  });

  it('reports each new origin in a pattern that names several', () => {
    const condition = { urlMatches: 'https://app.example.com/|https://a.test/|https://b.test/' };
    expect(found(checkPatchReach(insert(wait(condition)), workflow))).toEqual([
      ['new_origin', '/after/forCondition/urlMatches'],
      ['new_origin', '/after/forCondition/urlMatches'],
    ]);
  });

  it('checks pre, post, assert, guard and loop conditions, and nested steps', () => {
    const bad = { urlEquals: 'https://evil.test/' };
    const click = { ...stepOf('click_004'), id: 'click_901' };
    const cases: Array<[Loose, string]> = [
      [{ ...click, pre: [{ textPresent: 'x' }, bad] }, '/after/pre/1/urlEquals'],
      [{ ...click, post: [bad] }, '/after/post/0/urlEquals'],
      [
        { id: 'assert_900', intent: 'Check.', action: 'assert', condition: bad },
        '/after/condition/urlEquals',
      ],
      [
        { id: 'guard_900', intent: 'Maybe.', action: 'guard', if: bad, then: [click] },
        '/after/if/urlEquals',
      ],
      [
        { id: 'loop_900', intent: 'Repeat.', action: 'loop', while: bad, do: [click] },
        '/after/while/urlEquals',
      ],
      [
        {
          id: 'guard_900',
          intent: 'Maybe.',
          action: 'guard',
          if: { textPresent: 'x' },
          then: [click],
          else: [{ id: 'goto_901', intent: 'Go.', action: 'navigate', url: 'https://evil.test/' }],
        },
        '/after/else/0/url',
      ],
    ];
    for (const [step, path] of cases) {
      expect(found(checkPatchReach(insert(step), workflow))).toEqual([['new_origin', path]]);
    }
  });

  it('rejects a new origin added to a replaced step', () => {
    const patch = replace('click_004', {
      ...newTarget,
      pre: [{ urlMatches: 'https://evil.test/' }],
    });
    expect(found(checkPatchReach(patch, workflow))).toEqual([
      ['new_origin', '/after/pre/0/urlMatches'],
    ]);
  });
});

describe('checkPatchReach(): secrets', () => {
  it('accepts a patch on a step that has no secret', () => {
    const patch = replace('click_004', newTarget);
    expect(checkPatchReach(patch, workflow)).toEqual({ status: 'ok' });
  });

  it('accepts a change that leaves a secret step and its target alone', () => {
    const patch = replace('fill_002', { timeoutMs: 8000 });
    expect(checkPatchReach(patch, workflow)).toEqual({ status: 'ok' });
  });

  it('asks for approval when a step that types a secret gets a new target', () => {
    const patch = replace('fill_002', {
      target: { candidates: [{ kind: 'css', value: 'input[name=q]' }] },
    });
    const result = checkPatchReach(patch, workflow);
    expect(found(result)).toEqual([['secret_retargeted', '/after/target']]);
    expect(result.status).toBe('needs_approval');
    // The other two checks have no objection, which is why this one exists.
    expect(checkPatchScope(patch, workflow)).toEqual({ ok: true });
    expect(checkPatchClass(patch, workflow, 'selector')).toEqual({ ok: true });
  });

  it('asks for approval for a nested step that types a secret', () => {
    const patch = replace('fill_006', {
      target: { candidates: [{ kind: 'css', value: '#search' }] },
    });
    expect(checkPatchReach(patch, workflow).status).toBe('needs_approval');
  });

  it('does not ask for approval when a literal fill gets a new target', () => {
    const patch = replace('fill_003', {
      target: { candidates: [{ kind: 'css', value: '#month' }] },
    });
    expect(checkPatchReach(patch, workflow)).toEqual({ status: 'ok' });
  });

  it.each<[string, string, Loose, string]>([
    ['a retargeted secret', 'fill_002', { value: { secret: 'portal_user' } }, 'secret_changed'],
    ['a secret swapped for a literal', 'fill_002', { value: 'hunter2' }, 'secret_removed'],
    [
      'a literal swapped for a secret',
      'fill_003',
      { value: { secret: 'portal_pass' } },
      'secret_added',
    ],
  ])('rejects %s', (_name, id, changes, code) => {
    expect(found(checkPatchReach(replace(id, changes), workflow))).toEqual([
      [code, '/after/value'],
    ]);
  });

  it('rejects a navigate URL replaced by a secret', () => {
    const patch = replace('goto_001', { url: { secret: 'portal_pass' } });
    expect(found(checkPatchReach(patch, workflow))).toEqual([['secret_added', '/after/url']]);
  });

  it('rejects an inserted step that uses a secret, which would move it', () => {
    const fill = { ...stepOf('fill_002'), id: 'fill_900' };
    expect(found(checkPatchReach(insert(fill), workflow))).toEqual([
      ['secret_added', '/after/value'],
    ]);
  });

  it('rejects a secret added or changed in a nested step', () => {
    const nested = stepOf('fill_006');
    const patch = replace('guard_005', {
      then: [{ ...nested, value: { secret: 'portal_user' } }],
      else: [{ ...nested, id: 'fill_901' }],
    });
    expect(found(checkPatchReach(patch, workflow))).toEqual([
      ['secret_added', '/after/else/0/value'],
      ['secret_changed', '/after/then/0/value'],
    ]);
  });

  it('compares with the workflow, not with the "before" the patch reports', () => {
    const patch = replace('fill_002', { value: { secret: 'portal_user' } });
    patch.before = patch.after;
    expect(found(checkPatchReach(patch, workflow))).toEqual([['secret_changed', '/after/value']]);
  });

  it('rejects, not asks, when a patch both retargets and changes a secret', () => {
    const patch = replace('fill_002', {
      target: { candidates: [{ kind: 'css', value: '#q' }] },
      value: { secret: 'portal_user' },
    });
    expect(checkPatchReach(patch, workflow).status).toBe('rejected');
  });
});

describe('checkPatchReach(): the patch itself', () => {
  it('rejects a replace of a step that is not in the workflow', () => {
    const patch = { ...replace('click_004', newTarget), stepId: 'click_404' };
    expect(found(checkPatchReach(patch, workflow))).toEqual([['unknown_step', '/stepId']]);
  });

  it('reports every violation', () => {
    const patch = replace('goto_001', {
      url: 'https://evil.test/',
      post: [{ urlEquals: 'https://other.test/' }],
    });
    expect(found(checkPatchReach(patch, workflow))).toEqual([
      ['new_origin', '/after/url'],
      ['new_origin', '/after/post/0/urlEquals'],
    ]);
  });

  it('does not quote patch content in a message', () => {
    const patch = replace('fill_002', { value: 'SENTINEL-VALUE', url: 'https://sentinel.test/' });
    expect(JSON.stringify(checkPatchReach(patch, workflow))).not.toContain('entinel');
  });
});
