// Run the healer on the drift suite and write the results.
//
//   pnpm --filter @sfysh/benchmark heal:drift -- --provider anthropic \
//     --model claude-sonnet-5-5 --price-in 2 --price-out 10 --max-usd 5
//
// Options:
//   --provider <anthropic|openai|gemini|ollama|oracle>  required. `oracle`
//       answers with each case's known-correct heal and costs nothing: a
//       dry run of the harness, not a measurement.
//   --model <id>             model for the provider (default: its own).
//   --price-in <usd>         US dollars per million input tokens.
//   --price-out <usd>        US dollars per million output tokens. Without
//       both prices, tokens are recorded and cost is left out.
//   --max-usd <usd>          stop spending once this much is used (needs prices).
//   --max-tokens <n>         stop spending once this many tokens are used.
//   --runs <n>               runs per case (default 1; publish with 3 or more).
//   --cases <set>            which case set to run (default v1; see case-sets.ts).
//       A set meant to be held out runs only with --provider oracle until it
//       is frozen in suites.ts.
//   --case <id>              only cases whose id starts with this (repeatable).
//   --group <group>          only this group (single, robustness, silent, complex).
//   --out <dir>              default benchmark/results/drift-<timestamp>.
//
// Writes <out>/results.json (a header describing the run, then one entry
// per case run) and <out>/corpus/heals.jsonl (the heal corpus with a
// `benchmark` label after every heal; `compile report --dir <out>` reads it).

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { JsonlCorpus } from '@sfysh/healer';
import {
  AnthropicProvider,
  GeminiProvider,
  MemoryUsageLedger,
  MeteredProvider,
  OllamaProvider,
  OpenAIProvider,
} from '@sfysh/providers';
import type { Provider, UsageBudget } from '@sfysh/providers';
import { providerFailure } from './abort.js';
import type { RunAbort } from './abort.js';
import { CASE_SETS, caseSetByName, DEFAULT_CASE_SET, modelRunRefusal } from './case-sets.js';
import type { SuiteCase } from './case-kit.js';
import { loadBaseline, runDriftCase } from './heal-run.js';
import type { Baseline, CaseRunResult } from './heal-run.js';
import { OracleProvider } from './oracle-provider.js';
import { renderSummary } from './summary.js';

const here = dirname(fileURLToPath(import.meta.url));

// pnpm passes the `--` in `pnpm heal:drift -- --provider ...` through to the
// script, and parseArgs would read everything after it as positionals.
const argv = process.argv.slice(2);
if (argv[0] === '--') argv.shift();

const { values } = parseArgs({
  args: argv,
  options: {
    provider: { type: 'string' },
    model: { type: 'string' },
    'price-in': { type: 'string' },
    'price-out': { type: 'string' },
    'max-usd': { type: 'string' },
    'max-tokens': { type: 'string' },
    runs: { type: 'string', default: '1' },
    cases: { type: 'string', default: DEFAULT_CASE_SET },
    case: { type: 'string', multiple: true },
    group: { type: 'string' },
    out: { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function positive(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!(n >= 0 && Number.isFinite(n))) fail(`--${name} must be a non-negative number.`);
  return n;
}

const runs = positive('runs', values.runs)!;
if (!Number.isInteger(runs) || runs < 1) fail('--runs must be a whole number of 1 or more.');

const caseSet =
  caseSetByName(values.cases!) ??
  fail(`--cases must be one of ${CASE_SETS.map((s) => s.name).join(', ')}.`);
const casesSource = await readFile(join(here, caseSet.file), 'utf8');
const casesSha256 = createHash('sha256').update(casesSource).digest('hex');
if (values.provider !== 'oracle') {
  const refusal = modelRunRefusal(caseSet, casesSha256);
  if (refusal !== null) fail(refusal);
}

const oracle = values.provider === 'oracle' ? new OracleProvider() : undefined;
const vendor: Provider =
  oracle ??
  (() => {
    const config = values.model !== undefined ? { model: values.model } : {};
    switch (values.provider) {
      case 'anthropic':
        return new AnthropicProvider(config);
      case 'openai':
        return new OpenAIProvider(config);
      case 'gemini':
        return new GeminiProvider(config);
      case 'ollama':
        return new OllamaProvider(config);
      default:
        return fail('--provider must be one of anthropic, openai, gemini, ollama, oracle.');
    }
  })();

const priceIn = positive('price-in', values['price-in']);
const priceOut = positive('price-out', values['price-out']);
if ((priceIn === undefined) !== (priceOut === undefined)) {
  fail('Give both --price-in and --price-out, or neither.');
}
const prices =
  priceIn !== undefined && priceOut !== undefined && vendor.model !== undefined
    ? { [vendor.model]: { inputPerMTok: priceIn, outputPerMTok: priceOut } }
    : undefined;
const budget: UsageBudget = {};
const maxUsd = positive('max-usd', values['max-usd']);
const maxTokens = positive('max-tokens', values['max-tokens']);
if (maxUsd !== undefined) budget.maxUsd = maxUsd;
if (maxTokens !== undefined) budget.maxTokens = maxTokens;

const ledger = new MemoryUsageLedger();
const provider = new MeteredProvider(vendor, {
  ledger,
  budget,
  ...(prices ? { prices } : {}),
});

const selected = caseSet.cases.filter(
  (c) =>
    (values.case === undefined || values.case.some((prefix) => c.id.startsWith(prefix))) &&
    (values.group === undefined || c.group === values.group),
);
if (selected.length === 0) fail('No drift case matches --case and --group.');

const startedAt = new Date();
const out = resolve(
  values.out ??
    join(here, '..', 'results', `drift-${startedAt.toISOString().replace(/[:.]/g, '-')}`),
);
await mkdir(out, { recursive: true });
// Laid out as a CLI state directory, so `compile report --dir <out>` reads it.
const corpus = new JsonlCorpus({ dir: join(out, 'corpus') });

const header = {
  suite: {
    caseSet: caseSet.name,
    casesFile: caseSet.file,
    cases: caseSet.cases.length,
    selected: selected.length,
    casesSha256,
  },
  provider: vendor.name,
  model: vendor.model ?? null,
  prices: prices ?? null,
  budget,
  runsPerCase: runs,
  policy: 'human; every decided patch is applied as if a reviewer approved it',
  judge:
    'correct means the healed workflow, on page loads 1 and 2 of the drifted fixture, acts on the same marked elements in the same order as the original on the clean page, touches no decoy or unmarked element, and produces exactly the same outputs',
  dryRun: oracle !== undefined,
  startedAt: startedAt.toISOString(),
};

const browser = await chromium.launch();
const baselines = new Map<SuiteCase['fixture'], Baseline>();
const results: CaseRunResult[] = [];
let aborted: RunAbort | null = null;
try {
  cases: for (const driftCase of selected) {
    let baseline = baselines.get(driftCase.fixture);
    if (baseline === undefined) {
      baseline = await loadBaseline(browser, driftCase.fixture);
      baselines.set(driftCase.fixture, baseline);
    }
    for (let run = 1; run <= runs; run++) {
      process.stdout.write(`  ${driftCase.id} (run ${run})... `);
      // NOSONAR: sequential by design; cases share one browser, and the
      // budget is checked call by call.
      const result = await runDriftCase(
        driftCase,
        baseline,
        {
          browser,
          provider,
          ledger,
          corpus,
          ...(oracle ? { beforeHeal: oracle.beforeHeal } : {}),
        },
        run,
      );
      results.push(result);
      const verdict = result.judgement ? ` ${result.judgement.verdict}` : '';
      console.log(`${result.outcome}${verdict}  ${result.durationMs}ms`);
      // A provider failure a retry will not fix fails every later call
      // too, so stop rather than finish a run with no model in it (see
      // abort.ts). The oracle provider cannot fail this way.
      aborted = oracle ? null : providerFailure(result);
      if (aborted !== null) break cases;
    }
  }
} finally {
  await browser.close();
  await writeFile(
    join(out, 'results.json'),
    `${JSON.stringify({ ...header, finishedAt: new Date().toISOString(), ...(aborted ? { aborted } : {}), usage: ledger.totals(), results }, null, 2)}\n`,
  );
}

if (aborted !== null) {
  console.error(
    `\nStopped: the provider failed on ${aborted.caseId} (run ${aborted.run}) with "${aborted.code}": ${aborted.message}\n` +
      'Retrying will not fix this, so the run was stopped rather than finished without a model. ' +
      `Check the provider's API key and model name. Partial results: ${join(out, 'results.json')}`,
  );
  process.exit(1);
}

console.log(`\n${renderSummary(results, ledger.totals())}`);
console.log(`\nResults: ${join(out, 'results.json')}`);
console.log(`Corpus:  ${corpus.file}`);
if (oracle)
  console.log('Dry run with the oracle provider: these numbers measure the harness, not a model.');
