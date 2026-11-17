// Parsing for the `role` selector string format.
//
// A role candidate's value is a role name with optional attributes, for
// example `button[name='Sign in']`. Both the compiler (which emits a
// `getByRole` call) and the interpreter (which makes one) have to read that
// format the same way, so the parsing lives here, next to the schema that
// defines it.

/** A role attribute value: text, a number such as `level=2`, or a flag such as `exact=true`. */
export type RoleOptionValue = string | number | boolean;

export interface RoleSelector {
  /** The ARIA role, for example `button`. */
  role: string;
  /**
   * Attribute options, for example `{ name: 'Sign in' }` or
   * `{ level: 2, name: 'Title' }`. `name` and `description` are always
   * text. Other unquoted values are read as a number when they are all
   * digits and as a boolean when they are `true` or `false`.
   */
  options: {
    name?: string;
    description?: string;
    [attribute: string]: RoleOptionValue | undefined;
  };
  /**
   * Parts of the value that could not be read, in order. Empty when the
   * whole value was understood. Code that acts on the selector (the
   * compiler, the interpreter) must refuse one with anything here, so an
   * attribute is never dropped without a word.
   */
  unparsed: string[];
}

// Text attributes stay strings whatever they look like: a button named
// "2024" is still named by text.
const TEXT_ATTRIBUTES = new Set(['name', 'description']);

const ATTRIBUTE = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'\]\[]+))/y;
const SEPARATOR = /[\s\]\[,]+/y;

/**
 * Parse a `role` selector value.
 *
 * `button[name='Sign in']` gives `{ role: 'button', options: { name: 'Sign in' }, unparsed: [] }`.
 * `heading[level=2]` gives `{ role: 'heading', options: { level: 2 }, unparsed: [] }`.
 * `table` gives `{ role: 'table', options: {}, unparsed: [] }`.
 *
 * Never throws. A value that does not fit the format at all is returned
 * whole as the role, and also listed in `unparsed`. Inside the brackets,
 * anything that is not an `attribute=value` pair is listed in `unparsed`
 * and the pairs around it are still read.
 */
export function parseRoleSelector(value: string): RoleSelector {
  // `s`: an accessible name may contain a line break.
  const match = value.match(/^([a-z]+)(?:\[(.+)\])?$/is);
  if (!match) return { role: value, options: {}, unparsed: [value] };

  const [, role, attrs] = match;
  if (!attrs) return { role: role!, options: {}, unparsed: [] };

  const options: RoleSelector['options'] = {};
  const unparsed: string[] = [];
  // Walk the attribute text: skip separators, read a pair, and collect
  // anything else up to the next separator as unreadable.
  let at = 0;
  while (at < attrs.length) {
    SEPARATOR.lastIndex = at;
    if (SEPARATOR.test(attrs)) {
      at = SEPARATOR.lastIndex;
      continue;
    }
    ATTRIBUTE.lastIndex = at;
    const m = ATTRIBUTE.exec(attrs);
    if (m !== null) {
      const key = m[1]!;
      const quoted = m[2] ?? m[3];
      options[key] = quoted !== undefined ? quoted : coerce(key, m[4]!);
      at = ATTRIBUTE.lastIndex;
      continue;
    }
    const rest = attrs.slice(at);
    const end = rest.search(/[\s\]\[,]/);
    const piece = end === -1 ? rest : rest.slice(0, end);
    unparsed.push(piece);
    at += piece.length;
  }
  return { role: role!, options, unparsed };
}

function coerce(key: string, raw: string): RoleOptionValue {
  if (TEXT_ATTRIBUTES.has(key)) return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}
