import { describe, it, expect } from 'vitest';
import { extractCandidate, extractTarget, isLocatorLink } from '../src/selectors.js';
import type { ChainLink } from '../src/walker.js';

function link(method: string, ...args: string[]): ChainLink {
  return { method, args };
}

describe('isLocatorLink', () => {
  it.each(['getByRole', 'getByTestId', 'getByText', 'getByLabel', 'locator'])(
    'returns true for %s',
    (method) => {
      expect(isLocatorLink(link(method))).toBe(true);
    },
  );

  it.each(['click', 'fill', 'goto', 'waitForTimeout', 'toBeVisible'])(
    'returns false for %s',
    (method) => {
      expect(isLocatorLink(link(method))).toBe(false);
    },
  );
});

describe('extractCandidate', () => {
  it('extracts getByRole with no options', () => {
    expect(extractCandidate(link('getByRole', "'button'"))).toEqual({
      kind: 'role',
      value: 'button',
    });
  });

  it('extracts getByRole with name option into role[name] syntax', () => {
    expect(extractCandidate(link('getByRole', "'button'", "{ name: 'Submit' }"))).toEqual({
      kind: 'role',
      value: "button[name='Submit']",
    });
  });

  it('extracts getByRole with double-quoted name option', () => {
    expect(extractCandidate(link('getByRole', "'textbox'", '{ name: "Email" }'))).toEqual({
      kind: 'role',
      value: "textbox[name='Email']",
    });
  });

  it('ignores non-string options like exact: true', () => {
    expect(extractCandidate(link('getByRole', "'button'", "{ name: 'OK', exact: true }"))).toEqual({
      kind: 'role',
      value: "button[name='OK']",
    });
  });

  it('extracts getByTestId', () => {
    expect(extractCandidate(link('getByTestId', "'submit-btn'"))).toEqual({
      kind: 'testid',
      value: 'submit-btn',
    });
  });

  it('extracts getByText', () => {
    expect(extractCandidate(link('getByText', "'Hello World'"))).toEqual({
      kind: 'text',
      value: 'Hello World',
    });
  });

  it('extracts getByLabel', () => {
    expect(extractCandidate(link('getByLabel', "'Email'"))).toEqual({
      kind: 'label',
      value: 'Email',
    });
  });

  it('extracts locator as css', () => {
    expect(extractCandidate(link('locator', "'.my-class'"))).toEqual({
      kind: 'css',
      value: '.my-class',
    });
  });

  it('handles double-quoted arguments', () => {
    expect(extractCandidate(link('getByTestId', '"login-form"'))).toEqual({
      kind: 'testid',
      value: 'login-form',
    });
  });

  it('handles backtick-quoted arguments', () => {
    expect(extractCandidate(link('getByText', '`Welcome`'))).toEqual({
      kind: 'text',
      value: 'Welcome',
    });
  });

  it('returns undefined for non-literal arguments (variable references)', () => {
    expect(extractCandidate(link('getByTestId', 'myTestId'))).toBeUndefined();
  });

  it('returns undefined for unrecognized methods', () => {
    expect(extractCandidate(link('click'))).toBeUndefined();
  });

  it('returns undefined when no arguments are provided', () => {
    expect(extractCandidate(link('getByRole'))).toBeUndefined();
  });
});

describe('extractTarget', () => {
  it('extracts a target from a simple click chain', () => {
    const links = [link('getByRole', "'button'", "{ name: 'Submit' }"), link('click')];
    expect(extractTarget(links)).toEqual({
      candidates: [{ kind: 'role', value: "button[name='Submit']" }],
    });
  });

  it('extracts a target from a fill chain', () => {
    const links = [link('getByLabel', "'Email'"), link('fill', "'test@example.com'")];
    expect(extractTarget(links)).toEqual({
      candidates: [{ kind: 'label', value: 'Email' }],
    });
  });

  it('takes the innermost locator from a compound chain', () => {
    const links = [link('locator', "'.form'"), link('getByLabel', "'Email'"), link('fill', "'x'")];
    expect(extractTarget(links)).toEqual({
      candidates: [{ kind: 'label', value: 'Email' }],
    });
  });

  it('returns undefined when no locator links are present', () => {
    const links = [link('goto', "'https://example.com'")];
    expect(extractTarget(links)).toBeUndefined();
  });

  it('returns undefined for an empty links array', () => {
    expect(extractTarget([])).toBeUndefined();
  });

  it('extracts css from a plain locator chain', () => {
    const links = [link('locator', "'#submit'"), link('click')];
    expect(extractTarget(links)).toEqual({
      candidates: [{ kind: 'css', value: '#submit' }],
    });
  });

  it('skips locator links with non-literal args in a compound chain', () => {
    const links = [link('locator', 'containerSelector'), link('getByText', "'OK'"), link('click')];
    expect(extractTarget(links)).toEqual({
      candidates: [{ kind: 'text', value: 'OK' }],
    });
  });
});
