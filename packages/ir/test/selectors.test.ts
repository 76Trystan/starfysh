import { describe, it, expect } from 'vitest';
import { parseRoleSelector } from '../src/index.js';

describe('parseRoleSelector', () => {
  it('parses a bare role', () => {
    expect(parseRoleSelector('table')).toEqual({ role: 'table', options: {}, unparsed: [] });
  });

  it('parses a single-quoted attribute', () => {
    expect(parseRoleSelector("button[name='Sign in']")).toEqual({
      role: 'button',
      options: { name: 'Sign in' },
      unparsed: [],
    });
  });

  it('parses a double-quoted attribute', () => {
    expect(parseRoleSelector('button[name="Sign in"]')).toEqual({
      role: 'button',
      options: { name: 'Sign in' },
      unparsed: [],
    });
  });

  it('parses several attributes, in either bracket style', () => {
    const expected = {
      role: 'link',
      options: { name: 'Stock Report', description: 'Monthly' },
      unparsed: [],
    };
    expect(parseRoleSelector("link[name='Stock Report'][description='Monthly']")).toEqual(expected);
    expect(parseRoleSelector("link[name='Stock Report' description='Monthly']")).toEqual(expected);
    expect(parseRoleSelector("link[name='Stock Report', description='Monthly']")).toEqual(expected);
  });

  it('keeps quotes of the other kind inside a value', () => {
    expect(parseRoleSelector(`button[name="it's here"]`)).toEqual({
      role: 'button',
      options: { name: "it's here" },
      unparsed: [],
    });
  });

  it('reads unquoted numbers and flags with their types', () => {
    expect(parseRoleSelector("heading[level=2][name='Title']")).toEqual({
      role: 'heading',
      options: { level: 2, name: 'Title' },
      unparsed: [],
    });
    expect(parseRoleSelector('button[exact=true][disabled=false]')).toEqual({
      role: 'button',
      options: { exact: true, disabled: false },
      unparsed: [],
    });
  });

  it('reads an unquoted word as text', () => {
    expect(parseRoleSelector('button[name=Submit]')).toEqual({
      role: 'button',
      options: { name: 'Submit' },
      unparsed: [],
    });
  });

  it('keeps name and description as text even when they look like numbers or flags', () => {
    expect(parseRoleSelector('cell[name=2024][description=true]')).toEqual({
      role: 'cell',
      options: { name: '2024', description: 'true' },
      unparsed: [],
    });
  });

  it('lists what it cannot read instead of dropping it, and still reads the rest', () => {
    expect(parseRoleSelector("button[name='Go' disabled]")).toEqual({
      role: 'button',
      options: { name: 'Go' },
      unparsed: ['disabled'],
    });
    expect(parseRoleSelector("button[name='unclosed]").unparsed).not.toEqual([]);
  });

  it('returns a value that does not fit the format whole, as the role, and lists it', () => {
    expect(parseRoleSelector('not a role!')).toEqual({
      role: 'not a role!',
      options: {},
      unparsed: ['not a role!'],
    });
    expect(parseRoleSelector('')).toEqual({ role: '', options: {}, unparsed: [''] });
  });

  it('reads a name that contains a line break', () => {
    expect(parseRoleSelector("button[name='Save\nand close']")).toEqual({
      role: 'button',
      options: { name: 'Save\nand close' },
      unparsed: [],
    });
    expect(parseRoleSelector("button[name='a b']").options.name).toBe('a b');
  });

  it('accepts an empty attribute value', () => {
    expect(parseRoleSelector("textbox[name='']")).toEqual({
      role: 'textbox',
      options: { name: '' },
      unparsed: [],
    });
  });
});
