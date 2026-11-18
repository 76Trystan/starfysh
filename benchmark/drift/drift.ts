// Synthetic drift: controlled, reproducible site changes with a known
// right answer, for measuring the healer.
//
// A fixture is a small self-contained page served at a fake origin, with a
// workflow written against it. A drift is a list of DOM edits applied to
// the fixture on every load (`page-drift.js`). Running the workflow on the
// drifted page reproduces a site change; healing it and running the
// patched workflow shows what the heal did.
//
// The right answer does not come from verification. Elements the workflow
// is meant to act on carry a truth marker, and the fixture records which
// marked element each click and fill landed on. A heal is correct only if
// the patched workflow, on the drifted page, acts on the same elements in
// the same order as the original workflow on the clean page, and produces
// exactly the same outputs, with no tolerance. That catches the false heal
// verification cannot: a decoy that behaves the same and yields the same
// outputs. The healer never sees the markers; it sees the accessibility
// tree.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page as PlaywrightPage } from 'playwright-core';
import { validateWorkflow } from '@sfysh/ir';
import type { Workflow } from '@sfysh/ir';
import { asPage } from '@sfysh/playwright-adapter';
import { createInterpreter, replay } from '@sfysh/verifier';
import type { PageDisposer, PageFactory, ReplayOutcome } from '@sfysh/verifier';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE_SCRIPT = readFileSync(join(here, 'page-drift.js'), 'utf8');

/** One DOM edit. Selectors are the fixture author's, into the fixture's own markup. */
export type Drift =
  /** Replace an element's text (and so the accessible name of a link, button, label or heading). */
  | { op: 'rename_text'; selector: string; text: string }
  | { op: 'set_attribute'; selector: string; name: string; value: string }
  | { op: 'remove_attribute'; selector: string; name: string }
  /** Rebuild an element with another tag, keeping attributes and children. Changes its role. */
  | { op: 'retag'; selector: string; tag: string }
  /** Put every row's cells in the order of these old positions. */
  | { op: 'reorder_columns'; table: string; order: number[] }
  /** Move an element into a dropdown that opens with a new button. */
  | { op: 'wrap_in_menu'; selector: string; menuLabel: string }
  /** Cover the page with a banner until its button is pressed. */
  | { op: 'add_overlay'; text: string; dismissLabel: string }
  /** Add a working copy of an element with new text, marked as a decoy. */
  | { op: 'add_decoy'; selector: string; text: string; position: 'before' | 'after' }
  | { op: 'remove'; selector: string };

export interface DriftFixture {
  name: string;
  /** Origin the fixture is served at. The workflow navigates here. */
  origin: string;
  html: string;
  workflow: Workflow;
}

const FIXTURES: Record<string, { origin: string }> = {
  portal: { origin: 'https://portal.drift.test' },
};

/** Load a fixture and its workflow from `drift/fixtures/`. */
export function loadFixture(name: string): DriftFixture {
  const meta = FIXTURES[name];
  if (meta === undefined) throw new Error(`no drift fixture called ${name}`);
  const html = readFileSync(join(here, 'fixtures', `${name}.html`), 'utf8');
  const raw: unknown = JSON.parse(
    readFileSync(join(here, 'fixtures', `${name}.workflow.json`), 'utf8'),
  );
  const check = validateWorkflow(raw);
  if (!check.valid || !check.value) {
    throw new Error(`fixture workflow ${name} is not valid IR: ${JSON.stringify(check.errors[0])}`);
  }
  return { name, origin: meta.origin, html, workflow: check.value };
}

export interface DriftedPagesOptions {
  /**
   * Playwright's timeout for each action and wait. Default 2,000 ms: the
   * fixture renders instantly, and a broken selector would otherwise wait
   * Playwright's default 30 seconds on every case.
   */
  actionTimeoutMs?: number;
}

/** Pages showing a fixture with drifts applied, for `replay` and the healer. */
export interface DriftedPages {
  /** A fresh page per call, as `replay` and `verifyPatch` expect. */
  pageFactory: PageFactory;
  /** Closes the page. */
  dispose: PageDisposer;
  /**
   * What the last page recorded: each click and fill on a marked element
   * (`click:click_002`), on an unmarked one (`click:none`), or on something
   * a drift added (`click:drift:dismiss`, `click:decoy`). Throws if a drift
   * selector matched nothing. Read it before `dispose` runs.
   */
  lastTruth: () => Promise<string[]>;
}

export function driftedPages(
  browser: Browser,
  fixture: DriftFixture,
  drifts: readonly Drift[],
  options: DriftedPagesOptions = {},
): DriftedPages {
  let last: PlaywrightPage | undefined;
  const pageFactory: PageFactory = async () => {
    const page = await browser.newPage();
    page.setDefaultTimeout(options.actionTimeoutMs ?? 2_000);
    // Serve the fixture at its origin; nothing else is reachable.
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith(fixture.origin)) {
        await route.fulfill({ status: 200, contentType: 'text/html', body: fixture.html });
      } else {
        await route.abort();
      }
    });
    await page.addInitScript({
      content: `${PAGE_SCRIPT}\n__sfyshApplyDrifts(${JSON.stringify(drifts)});`,
    });
    last = page;
    return asPage(page);
  };
  const lastTruth = async (): Promise<string[]> => {
    if (last === undefined || last.isClosed()) return [];
    const { truth, errors } = await last.evaluate(() => {
      const w = globalThis as unknown as { __sfyshTruth?: string[]; __sfyshDriftErrors?: string[] };
      return { truth: w.__sfyshTruth ?? [], errors: w.__sfyshDriftErrors ?? [] };
    });
    if (errors.length > 0) throw new Error(`drift could not be applied: ${errors.join('; ')}`);
    return truth;
  };
  const dispose: PageDisposer = async () => {
    if (last !== undefined && !last.isClosed()) await last.close();
  };
  return { pageFactory, dispose, lastTruth };
}

/** What one run of a workflow did on a (possibly drifted) fixture. */
export interface Observation {
  status: ReplayOutcome['status'];
  outputs: unknown[];
  /** Marked elements acted on, in order. See `DriftedPages.lastTruth`. */
  truth: string[];
  error?: ReplayOutcome['error'];
  degraded?: ReplayOutcome['degraded'];
  /** The full outcome, for the healer (it carries the page snapshot on failure). */
  outcome: ReplayOutcome;
}

export interface ObserveOptions extends DriftedPagesOptions {
  /** Default `'fallthrough'`, as compiled code runs. `'first'` shows what breaks. */
  candidates?: 'first' | 'fallthrough';
}

/** Run `workflow` once on the fixture with `drifts` applied, and record what it did. */
export async function observe(
  browser: Browser,
  fixture: DriftFixture,
  drifts: readonly Drift[],
  workflow: Workflow = fixture.workflow,
  options: ObserveOptions = {},
): Promise<Observation> {
  const pages = driftedPages(browser, fixture, drifts, options);
  let truth: string[] = [];
  // `replay` swallows disposer errors on purpose, so a broken drift found
  // while reading the truth log is kept here and thrown after it returns.
  let broken: unknown;
  const report = await replay(workflow, {
    pageFactory: pages.pageFactory,
    runner: createInterpreter({ candidates: options.candidates ?? 'fallthrough' }),
    runs: 1,
    dispose: async (ctx) => {
      try {
        truth = await pages.lastTruth();
      } catch (error) {
        broken = error;
      }
      await pages.dispose(ctx);
    },
  });
  if (broken !== undefined) throw broken;
  const outcome = report.replays[0]!;
  return {
    status: outcome.status,
    outputs: outcome.outputs,
    truth,
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.degraded ? { degraded: outcome.degraded } : {}),
    outcome,
  };
}

export interface HealJudgement {
  verdict: 'correct' | 'false_heal';
  /** Why it is a false heal. Empty when correct. */
  reasons: string[];
}

/**
 * Judge a healed workflow against ground truth. `baseline` is the original
 * workflow on the clean fixture; `patched` is the healed workflow on the
 * drifted one. Correct means it passed, acted on the same marked elements
 * in the same order (clicks on elements a drift added, such as a dismiss
 * button, are allowed), touched no decoy or unmarked element, and produced
 * exactly the same outputs.
 */
export function judgeHeal(baseline: Observation, patched: Observation): HealJudgement {
  const reasons: string[] = [];
  if (patched.status !== 'ok') reasons.push('the patched workflow failed on the drifted page');

  const acted = patched.truth.filter((t) => !t.includes(':drift:'));
  const strays = acted.filter((t) => t.endsWith(':none') || t.endsWith(':decoy'));
  if (strays.length > 0) {
    reasons.push(`it acted on elements it was not meant to (${[...new Set(strays)].join(', ')})`);
  }
  if (JSON.stringify(acted) !== JSON.stringify(baseline.truth)) {
    reasons.push(
      `it acted on ${acted.join(', ') || 'nothing'} where the original acted on ${baseline.truth.join(', ')}`,
    );
  }
  if (canonical(patched.outputs) !== canonical(baseline.outputs)) {
    reasons.push('its outputs differ from the original workflow on the clean page');
  }
  return { verdict: reasons.length === 0 ? 'correct' : 'false_heal', reasons };
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}
