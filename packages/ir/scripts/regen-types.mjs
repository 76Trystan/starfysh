#!/usr/bin/env node
// Regenerates src/types.ts from the JSON Schemas in src/schema/.
// Keeps TypeScript types in sync with the authoritative schemas.
//
// Post-processing:
// - Prepends a JSONSchemaFragment type alias.
// - Replaces the useless `{}` placeholder that json-schema-to-typescript emits
//   for untyped object fields (JSON-Schema-fragment positions like
//   Workflow.parameters, Workflow.outputs, Extract.schema) with
//   JSONSchemaFragment so downstream consumers get useful typing.

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
  '/**',
  ' * A fragment of a JSON Schema document. Used for workflow parameters,',
  ' * outputs, and extraction schemas, which are themselves JSON Schemas.',
  ' * Deliberately loose: schemas are user-authored and may use any valid',
  ' * JSON Schema construct. Runtime validation enforces well-formedness.',
  ' */',
  'export type JSONSchemaFragment = Record<string, unknown>;',
  '',
].join('\n');

const rawTs = await compileFromFile(join(schemaDir, 'workflow.schema.json'), {
  cwd: schemaDir,
  bannerComment: banner,
  additionalProperties: false,
  style: {
    singleQuote: true,
    trailingComma: 'all',
    printWidth: 100,
  },
});

// Post-process: replace `{}` placeholders in JSON-Schema-fragment positions.
// json-schema-to-typescript emits `{}` when a schema says `type: object` with
// no `properties`. In our case these are all legitimate JSON Schema fragments
// (parameters, outputs, extract.schema) that should be typed as such.
//
// The replacement is narrow and specific to avoid clobbering unrelated `{}`.
const ts = rawTs
  // Standalone field: `foo?: {};` or `foo: {};`
  .replace(/(\w+)(\??)\s*:\s*\{\s*\};/g, (_, name, optional) => {
    // Only replace fields that are plausibly JSON Schema fragments.
    if (['outputs', 'schema', 'parameters'].includes(name)) {
      return `${name}${optional}: JSONSchemaFragment;`;
    }
    return `${name}${optional}: {};`;
  })
  // Index signature inside parameters: `[k: string]: {};`
  .replace(/\[k:\s*string\]\s*:\s*\{\s*\};/g, '[k: string]: JSONSchemaFragment;');

writeFileSync(outPath, ts, 'utf-8');
console.log(`Generated ${outPath}`);
