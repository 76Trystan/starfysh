import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const content = `export const COMPILER_VERSION = '${pkg.version}';\n`;
writeFileSync(join(root, 'src', 'version.ts'), content);
