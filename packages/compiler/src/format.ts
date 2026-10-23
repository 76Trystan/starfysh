// Deterministic Prettier formatting for generated code.
//
// Every compile pass must produce byte-identical output for the same IR.
// Prettier config is pinned here (not read from the user's workspace) so
// upstream Prettier edits cannot silently change the generated code.

import * as prettier from 'prettier';

const prettierOptions: prettier.Options = {
  parser: 'typescript',
  printWidth: 100,
  singleQuote: true,
  trailingComma: 'all',
  semi: true,
  tabWidth: 2,
  arrowParens: 'always',
};

/**
 * Format TypeScript source with the pinned compiler Prettier config.
 * Returns byte-stable output for the same input.
 */
export async function formatTypeScript(source: string): Promise<string> {
  return prettier.format(source, prettierOptions);
}
