// Build the published report for a drift heal run.
//
//   pnpm --filter @sfysh/benchmark report:drift -- results/drift-<timestamp> \
//     --suite-version "drift-suite v1"
//
// Takes a results folder (or its results.json) written by `heal:drift`.
// Writes report.md and report.json into the same folder and prints the
// Markdown. The report says at the top why it is not fit to publish when
// it is not: a dry run, a partial suite, no frozen suite (or one the
// results were not run on), the tuning set, fewer than 3 runs per case,
// or unpriced calls. Without --suite-version the suite is found from the
// cases.ts hash in results.json (see suites.ts).

import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildReport, renderReport } from './report.js';
import type { DriftResultsFile } from './report.js';

// pnpm passes the `--` in `pnpm report:drift -- <dir>` through to the
// script, and parseArgs would read everything after it as positionals.
const argv = process.argv.slice(2);
if (argv[0] === '--') argv.shift();

const { values, positionals } = parseArgs({
  args: argv,
  allowPositionals: true,
  options: {
    'suite-version': { type: 'string' },
  },
});

if (positionals.length !== 1) {
  console.error('Usage: report:drift -- <results folder or results.json> [--suite-version <name>]');
  process.exit(1);
}

const target = positionals[0]!;
const file = (await stat(target)).isDirectory() ? join(target, 'results.json') : target;
const dir = dirname(file);
const results = JSON.parse(await readFile(file, 'utf8')) as DriftResultsFile;

const suiteVersion = values['suite-version'];
const report = buildReport(results, suiteVersion !== undefined ? { suiteVersion } : {});
const markdown = renderReport(report);

await writeFile(join(dir, 'report.md'), markdown);
await writeFile(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

console.log(markdown);
console.log(`Report: ${join(dir, 'report.md')}`);
console.log(`Data:   ${join(dir, 'report.json')}`);
