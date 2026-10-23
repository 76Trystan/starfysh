import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateWorkflow, validateStep, isWorkflow, isStep, IR_VERSION } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const supplierPortal = JSON.parse(
  readFileSync(
    join(__dirname, '..', 'src', 'schema', 'examples', 'supplier-portal.workflow.json'),
    'utf-8',
  ),
) as Record<string, unknown>;

describe('IR_VERSION', () => {
  it('is a semver-shaped string', () => {
    expect(IR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('matches the irVersion of the reference workflow', () => {
    expect(supplierPortal.irVersion).toBe(IR_VERSION);
  });
});

describe('validateWorkflow, accepts valid input', () => {
  it('accepts the reference supplier-portal workflow', () => {
    const result = validateWorkflow(supplierPortal);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.value).toBeDefined();
  });

  it('accepts a minimal workflow with one navigate step', () => {
    const result = validateWorkflow({
      irVersion: '1.0.0',
      id: 'minimal',
      name: 'Minimal workflow',
      steps: [
        {
          id: 'go_home',
          intent: 'Open the homepage.',
          action: 'navigate',
          url: 'https://example.com',
        },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe('validateWorkflow, rejects malformed input', () => {
  it('rejects a workflow missing irVersion', () => {
    const { irVersion: _ignored, ...rest } = supplierPortal;
    const result = validateWorkflow(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.params['missingProperty'] === 'irVersion')).toBe(true);
  });

  it('rejects a workflow with no steps', () => {
    const result = validateWorkflow({ ...supplierPortal, steps: [] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === 'minItems')).toBe(true);
  });

  it('rejects a workflow with an invalid id pattern', () => {
    const result = validateWorkflow({ ...supplierPortal, id: 'INVALID CAPS SPACES' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === 'pattern')).toBe(true);
  });

  it('rejects an irVersion that is not semver-shaped', () => {
    const result = validateWorkflow({ ...supplierPortal, irVersion: 'v1' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === 'pattern')).toBe(true);
  });

  it('rejects a fill step missing its value', () => {
    const broken = structuredClone(supplierPortal) as {
      steps: Array<Record<string, unknown>>;
    };
    delete broken.steps[1]!['value'];
    const result = validateWorkflow(broken);
    expect(result.valid).toBe(false);
  });

  it('rejects a workflow with unknown top-level properties', () => {
    const result = validateWorkflow({ ...supplierPortal, somethingWeird: true });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === 'additionalProperties')).toBe(true);
  });
});

describe('validateStep, accepts valid steps', () => {
  it('accepts a well-formed click step', () => {
    const result = validateStep({
      id: 'test_click',
      intent: 'Click the Go button.',
      action: 'click',
      target: {
        candidates: [{ kind: 'role', value: "button[name='Go']" }],
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('accepts a nested guard with a child click step', () => {
    const result = validateStep({
      id: 'cookie_banner',
      intent: 'Accept cookies if banner is shown.',
      action: 'guard',
      if: { selectorVisible: "button:has-text('Accept')" },
      then: [
        {
          id: 'child_accept',
          intent: 'Click Accept.',
          action: 'click',
          target: { candidates: [{ kind: 'text', value: 'Accept' }] },
        },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('accepts a fill step referencing a secret', () => {
    const result = validateStep({
      id: 'fill_password',
      intent: 'Fill the password field.',
      action: 'fill',
      target: {
        candidates: [{ kind: 'role', value: "textbox[name='Password']" }],
      },
      value: { secret: 'portal_password' },
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('accepts a loop step with foreach and a child step', () => {
    const result = validateStep({
      id: 'loop_rows',
      intent: 'Iterate table rows.',
      action: 'loop',
      foreach: {
        candidates: [{ kind: 'css', value: 'table tr' }],
      },
      do: [
        {
          id: 'click_row',
          intent: 'Click the row.',
          action: 'click',
          target: { candidates: [{ kind: 'role', value: 'row' }] },
        },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe('validateStep, rejects malformed steps', () => {
  it('rejects a click step with no target', () => {
    const result = validateStep({
      id: 'bad_click',
      intent: 'Click with no target.',
      action: 'click',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a step with an invalid id pattern', () => {
    const result = validateStep({
      id: 'INVALID-CAPS',
      intent: 'bad id',
      action: 'click',
      target: { candidates: [{ kind: 'role', value: 'button' }] },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === 'pattern')).toBe(true);
  });

  it('rejects a step with an unknown action', () => {
    const result = validateStep({
      id: 'bad_action',
      intent: 'Do a nonexistent thing.',
      action: 'teleport',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === 'enum')).toBe(true);
  });

  it('rejects a loop step with neither foreach nor while', () => {
    const result = validateStep({
      id: 'bad_loop',
      intent: 'Loop with no termination.',
      action: 'loop',
      do: [
        {
          id: 'noop',
          intent: 'Noop.',
          action: 'wait',
          millis: 100,
        },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a secret ref with uppercase letters', () => {
    const result = validateStep({
      id: 'bad_secret_ref',
      intent: 'Fill with a bad secret name.',
      action: 'fill',
      target: {
        candidates: [{ kind: 'role', value: "textbox[name='X']" }],
      },
      value: { secret: 'InvalidName' },
    });
    expect(result.valid).toBe(false);
  });
});

describe('type guards', () => {
  it('isWorkflow returns true for the reference workflow', () => {
    expect(isWorkflow(supplierPortal)).toBe(true);
  });

  it('isWorkflow returns false for a plain object', () => {
    expect(isWorkflow({ hello: 'world' })).toBe(false);
  });

  it('isStep returns true for a well-formed navigate step', () => {
    expect(
      isStep({
        id: 'step_nav',
        intent: 'Go home.',
        action: 'navigate',
        url: 'https://example.com',
      }),
    ).toBe(true);
  });

  it('isStep returns false for a missing-action step', () => {
    expect(isStep({ id: 'x', intent: 'nope' })).toBe(false);
  });
});
