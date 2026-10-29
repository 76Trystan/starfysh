import { chromium } from 'playwright-core';
import { listWorkflows } from '@sfysh/runtime';
import { runTask } from './runner.js';
import { writeReport } from './reporter.js';

// Import task modules to register their workflows as side effects.
import '../tasks/books-catalogue/workflow.js';
import '../tasks/books-category/workflow.js';
import '../tasks/books-detail/workflow.js';
import '../tasks/hacker-news/workflow.js';
import '../tasks/wikipedia/workflow.js';

const start = Date.now();
const browser = await chromium.launch({ headless: true });

const results = [];
for (const id of listWorkflows()) {
  process.stdout.write(`  ${id}... `);
  // NOSONAR: sequential by design, shared browser and clean per-task timings
  const result = await runTask(browser, id);
  results.push(result);
  const label = result.status === 'ok' ? 'ok' : `FAILED (${result.error?.kind ?? 'unknown'})`;
  console.log(`${label}  ${result.durationMs}ms`);
}

await browser.close();

const path = await writeReport(results, Date.now() - start);
const passed = results.filter((r) => r.status === 'ok').length;
console.log(`\n${passed}/${results.length} passed, results at ${path}`);

if (results.some((r) => r.status === 'failed')) process.exit(1);
