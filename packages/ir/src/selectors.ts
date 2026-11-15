// Parsing for the `role` selector string format.
//
// A role candidate's value is a role name with optional attributes, for
// example `button[name='Sign in']`. Both the compiler (which emits a
// `getByRole` call) and the interpreter (which makes one) have to read that
// format the same way, so the parsing lives here, next to the schema that
// defines it.

export interface RoleSelector {
  /** The ARIA role, for example `button`. */
  role: string;
  /**
   * Attribute options, for example `{ name: 'Sign in' }`. Only attributes
   * written as quoted strings are recognised; anything else is dropped.
   */
  options: Record<string, string>;
}

/**
 * Parse a `role` selector value.
 *
 * `button[name='Sign in']` gives `{ role: 'button', options: { name: 'Sign in' } }`.
 * `table` gives `{ role: 'table', options: {} }`.
 *
 * A value that does not fit the format is returned whole as the role with
 * no options, so the caller still makes a lookup and the failure, if there
 * is one, comes from the page and not from the parser.
 */
export function parseRoleSelector(value: string): RoleSelector {
  const match = value.match(/^([a-z]+)(?:\[(.+)\])?$/i);
  if (!match) return { role: value, options: {} };

  const [, role, attrs] = match;
  if (!attrs) return { role: role!, options: {} };

  const options: Record<string, string> = {};
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs)) !== null) {
    options[m[1]!] = m[2] ?? m[3] ?? '';
  }
  return { role: role!, options };
}
