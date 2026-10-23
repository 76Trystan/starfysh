#!/usr/bin/env node
// Regenerates src/types.ts from the JSON Schemas in src/schema/.
// Keeps TypeScript types in sync with the authoritative schemas.

import { compileFromFile } from 'json-schema-to-typescript';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(scriptDir);
const schemaDir = join(packageDir, 'src', 'schema');
const outPath = join(packageDir, 'src', 'types.ts');

const banner = [
  '// Generated from JSON Schema. Do not edit by hand.',
  '// Run `pnpm --filter @asc/ir regen-types` to regenerate.',
  '',
].join('\n');

const ts = await compileFromFile(join(schemaDir, 'workflow.schema.json'), {
  cwd: schemaDir,
  bannerComment: banner,
  additionalProperties: false,
  style: {
    singleQuote: true,
    trailingComma: 'all',
    printWidth: 100,
  },
});

writeFileSync(outPath, ts, 'utf-8');
console.log(`Generated ${outPath}`);
