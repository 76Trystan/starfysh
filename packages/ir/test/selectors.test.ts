import { describe, it, expect } from 'vitest';
import { parseRoleSelector } from '../src/index.js';

describe('parseRoleSelector', () => {
  it('parses a bare role', () => {
    expect(parseRoleSelector('table')).toEqual({ role: 'table', options: {} });
  });

  it('parses a single-quoted attribute', () => {
    expect(parseRoleSelector("button[name='Sign in']")).toEqual({
      role: 'button',
      options: { name: 'Sign in' },
    });
  });

  it('parses a double-quoted attribute', () => {
    expect(parseRoleSelector('button[name="Sign in"]')).toEqual({
      role: 'button',
      options: { name: 'Sign in' },
    });
  });

  it('parses several attributes, in either bracket style', () => {
    const expected = { role: 'link', options: { name: 'Stock Report', description: 'Monthly' } };
    expect(parseRoleSelector("link[name='Stock Report'][description='Monthly']")).toEqual(expected);
    expect(parseRoleSelector("link[name='Stock Report' description='Monthly']")).toEqual(expected);
  });

  it('keeps quotes of the other kind inside a value', () => {
    expect(parseRoleSelector(`button[name="it's here"]`)).toEqual({
      role: 'button',
      options: { name: "it's here" },
    });
  });

  it('drops attributes that are not quoted strings', () => {
    expect(parseRoleSelector("heading[level=2][name='Title']")).toEqual({
      role: 'heading',
      options: { name: 'Title' },
    });
    expect(parseRoleSelector('button[exact=true]')).toEqual({ role: 'button', options: {} });
  });

  it('returns a value that does not fit the format whole, as the role', () => {
    expect(parseRoleSelector('not a role!')).toEqual({ role: 'not a role!', options: {} });
    expect(parseRoleSelector('')).toEqual({ role: '', options: {} });
  });

  it('accepts an empty attribute value', () => {
    expect(parseRoleSelector("textbox[name='']")).toEqual({
      role: 'textbox',
      options: { name: '' },
    });
  });
});
