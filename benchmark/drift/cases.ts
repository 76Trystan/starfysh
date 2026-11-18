// Drift cases: named, reproducible site changes on a fixture, each with
// what it is expected to do to the fixture's workflow and, when it can be
// healed, a correct heal (the oracle). The self-tests (`drift.test.ts`)
// hold every case to its expectation, prove every oracle passes the
// healer's own rules and is judged correct, so a case that stops breaking
// what it claims, or a "healable" case no allowed patch can fix, is caught
// before it skews a measurement.
//
// Four groups:
// - single changes: one thing moves, renames or disappears;
// - robustness: changes the workflow should survive untouched;
// - silent: the run passes with wrong outputs and the healer never hears;
// - complex: redesigns that need several heals, locale changes, A/B tests,
//   intermittent banners, identical twins, shadow DOM, iframes and late
//   rendering. Some of these are known gaps in what Starfysh can heal,
//   marked with `gap` so the benchmark reports them as such.

import type { Condition, SelectorCandidate } from '@sfysh/ir';
import type { Drift } from './drift.js';
import type { OraclePatch } from './oracle.js';

export type DriftEffect =
  /** The run fails, even with selector fallback. The healer is invoked. */
  | 'fails'
  /** The run passes, but only on a fallback selector. A promotion is offered. */
  | 'degrades'
  /** The workflow copes: same outputs, no fallback. Documents a robustness. */
  | 'none'
  /**
   * The run passes with different outputs: an extract read nothing, or
   * less. No failure, so the healer is never invoked. Documents a gap that
   * only the output history and the post-accept watch can catch.
   */
  | 'silent';

export type DriftHeal =
  /** Move the working fallback to the front (no model). */
  | 'promotion'
  /** New selectors for the step. */
  | 'selector'
  /** One step before the failed one (open a menu, dismiss a banner, wait). */
  | 'insert_step'
  /** No allowed patch can restore the workflow; the healer should say so. */
  | 'not_healable'
  /** Nothing for the healer to do. */
  | 'none';

/**
 * Why a case cannot be healed today when a person could fix it. Absent on
 * a `not_healable` case means nothing could: the feature is gone.
 * - `ab_test`: the site alternates between designs; a patch verified with
 *   its first selector only fails on the other design.
 * - `intermittent`: a banner shows on some loads; an inserted dismiss
 *   click fails when it is absent (a guard would be needed).
 * - `iframe`: the element moved into a frame the runtime cannot enter.
 * - `header_alias`: a table header was renamed; the fix is an `x-header`
 *   alias, and patches may not change an extract schema.
 */
export type DriftGap = 'ab_test' | 'intermittent' | 'iframe' | 'header_alias';

export interface DriftCase {
  id: string;
  /** What the change is, as a site owner would describe it. */
  description: string;
  fixture: 'portal' | 'shop';
  drifts: Drift[];
  expect: {
    effect: DriftEffect;
    /** The step that breaks first: where the run fails, or the first step that degrades. */
    step?: string;
    /** For `degrades`: every step that degrades, in order. Default `[step]`. */
    steps?: string[];
    /** The first heal a healer should make. */
    heal: DriftHeal;
    /**
     * A decoy that behaves like the real element is on the page. A heal
     * that picks it passes verification with identical outputs; only the
     * truth markers show it is wrong.
     */
    trap?: boolean;
    gap?: DriftGap;
  };
  /**
   * A correct heal, as successive patches. Present on every case whose
   * `heal` is `promotion`, `selector` or `insert_step`. More than one patch
   * means the case needs several heals in a row.
   */
  oracle?: OraclePatch[];
}

// Where a step's element is, by its truth marker.
const at = (step: string) => `[data-sfysh-truth="${step}"]`;

// Drift operators.
const rename = (selector: string, text: string): Drift => ({ op: 'rename_text', selector, text });
const setAttr = (selector: string, name: string, value: string): Drift => ({
  op: 'set_attribute',
  selector,
  name,
  value,
});
const dropAttr = (selector: string, name: string): Drift => ({
  op: 'remove_attribute',
  selector,
  name,
});
const retag = (selector: string, tag: string): Drift => ({ op: 'retag', selector, tag });
const menu = (selector: string, menuLabel: string): Drift => ({
  op: 'wrap_in_menu',
  selector,
  menuLabel,
});
const banner = (text: string, dismissLabel: string): Drift => ({
  op: 'add_overlay',
  text,
  dismissLabel,
});
const decoy = (selector: string, text: string, position: 'before' | 'after' = 'before'): Drift => ({
  op: 'add_decoy',
  selector,
  text,
  position,
});
const remove = (selector: string): Drift => ({ op: 'remove', selector });
const onLoads = (loads: number[], drifts: Drift[]): Drift => ({ op: 'on_loads', loads, drifts });
const shadow = (selector: string): Drift => ({ op: 'shadow', selector });
const iframe = (selector: string, title: string): Drift => ({ op: 'iframe', selector, title });
const delay = (selector: string, ms: number): Drift => ({ op: 'delay', selector, ms });

// Selector candidates.
const role = (value: string): SelectorCandidate => ({ kind: 'role', value });
const testid = (value: string): SelectorCandidate => ({ kind: 'testid', value });
const label = (value: string): SelectorCandidate => ({ kind: 'label', value });
const text = (value: string): SelectorCandidate => ({ kind: 'text', value });
const css = (value: string): SelectorCandidate => ({ kind: 'css', value });

// Oracle patches.
const reselect = (stepId: string, ...candidates: SelectorCandidate[]): OraclePatch => ({
  kind: 'reselect',
  stepId,
  candidates,
});
const promote = (stepId: string, index = 1): OraclePatch => ({ kind: 'promote', stepId, index });
const clickFirst = (
  beforeStepId: string,
  target: SelectorCandidate,
  intent: string,
): OraclePatch => ({
  kind: 'insert_click',
  beforeStepId,
  target,
  intent,
});
const waitFirst = (beforeStepId: string, until: Condition, intent: string): OraclePatch => ({
  kind: 'insert_wait',
  beforeStepId,
  until,
  intent,
});

type Row = [
  id: string,
  description: string,
  drifts: Drift[],
  expect: DriftCase['expect'],
  oracle?: OraclePatch[],
];

function cases(fixture: DriftCase['fixture'], rows: Row[]): DriftCase[] {
  return rows.map(([id, description, drifts, expect, oracle]) => ({
    id: `${fixture}-${id}`,
    description,
    fixture,
    drifts,
    expect,
    ...(oracle !== undefined ? { oracle } : {}),
  }));
}

export const PORTAL_CASES: DriftCase[] = cases('portal', [
  // The Orders link (click_002: role link 'Orders', css nav a.nav-orders).
  [
    'rename-orders-link',
    "The 'Orders' link is renamed 'Purchases'.",
    [rename(at('click_002'), 'Purchases')],
    { effect: 'degrades', step: 'click_002', heal: 'promotion' },
    [promote('click_002')],
  ],
  [
    'rename-and-restyle-orders-link',
    "The 'Orders' link is renamed 'Purchases' and its class changes.",
    [rename(at('click_002'), 'Purchases'), setAttr(at('click_002'), 'class', 'nav-purchases')],
    { effect: 'fails', step: 'click_002', heal: 'selector' },
    [reselect('click_002', role("link[name='Purchases']"), css('nav a.nav-purchases'))],
  ],
  [
    'orders-link-becomes-button',
    "The 'Orders' link is rebuilt as a button.",
    [retag(at('click_002'), 'button')],
    { effect: 'fails', step: 'click_002', heal: 'selector' },
    [reselect('click_002', role("button[name='Orders']"), css('nav button.nav-orders'))],
  ],
  [
    'orders-link-uppercase',
    "The 'Orders' link now reads 'ORDERS'.",
    [rename(at('click_002'), 'ORDERS')],
    { effect: 'none', heal: 'none' },
  ],
  [
    'orders-link-my-orders',
    "The 'Orders' link now reads 'My orders' (role names match by substring).",
    [rename(at('click_002'), 'My orders')],
    { effect: 'none', heal: 'none' },
  ],
  [
    'orders-link-restyled-only',
    "The 'Orders' link's class changes; its text does not.",
    [setAttr(at('click_002'), 'class', 'nav-link')],
    { effect: 'none', heal: 'none' },
  ],
  [
    'orders-in-menu',
    "The 'Orders' link moves into a 'More' dropdown.",
    [menu(at('click_002'), 'More')],
    { effect: 'fails', step: 'click_002', heal: 'insert_step' },
    [clickFirst('click_002', role("button[name='More']"), 'Open the More menu.')],
  ],
  [
    'renamed-link-with-decoy',
    "The 'Orders' link is renamed 'Purchases' and restyled, and an 'Order archive' link that opens the same page appears next to it.",
    [
      rename(at('click_002'), 'Purchases'),
      setAttr(at('click_002'), 'class', 'nav-purchases'),
      decoy(at('click_002'), 'Order archive'),
    ],
    { effect: 'fails', step: 'click_002', heal: 'selector', trap: true },
    [reselect('click_002', role("link[name='Purchases']"))],
  ],
  [
    'orders-link-removed',
    "The 'Orders' link is removed; the orders page cannot be reached.",
    [remove(at('click_002'))],
    { effect: 'fails', step: 'click_002', heal: 'not_healable' },
  ],
  // Banners covering the page before the first click.
  [
    'cookie-banner',
    'A cookie banner now covers the page until accepted.',
    [banner('We use cookies', 'Accept all')],
    { effect: 'fails', step: 'click_002', heal: 'insert_step' },
    [clickFirst('click_002', role("button[name='Accept all']"), 'Accept the cookie banner.')],
  ],
  [
    'notice-banner-got-it',
    "A service notice covers the page until 'Got it' is pressed.",
    [banner('Scheduled maintenance on Sunday', 'Got it')],
    { effect: 'fails', step: 'click_002', heal: 'insert_step' },
    [clickFirst('click_002', role("button[name='Got it']"), 'Dismiss the notice.')],
  ],
  [
    'survey-banner-close',
    "A survey invitation covers the page until 'Close' is pressed.",
    [banner('Tell us what you think', 'Close')],
    { effect: 'fails', step: 'click_002', heal: 'insert_step' },
    [clickFirst('click_002', role("button[name='Close']"), 'Close the survey invitation.')],
  ],
  // The search field (fill_003: label 'Search orders', testid order-search).
  [
    'relabel-search',
    "The search box's label changes to 'Find an order'.",
    [rename('label[for="search"]', 'Find an order')],
    { effect: 'degrades', step: 'fill_003', heal: 'promotion' },
    [promote('fill_003')],
  ],
  [
    'relabel-search-drop-testid',
    "The search box's label changes to 'Find an order' and it loses its test id.",
    [rename('label[for="search"]', 'Find an order'), dropAttr(at('fill_003'), 'data-testid')],
    { effect: 'fails', step: 'fill_003', heal: 'selector' },
    [reselect('fill_003', label('Find an order'))],
  ],
  [
    'search-new-testid',
    "The search box's test id changes; its label does not.",
    [setAttr(at('fill_003'), 'data-testid', 'search-box')],
    { effect: 'none', heal: 'none' },
  ],
  // The Apply button (click_004: role button 'Apply', testid apply-filter).
  [
    'rename-apply',
    "The 'Apply' button is renamed 'Search'.",
    [rename(at('click_004'), 'Search')],
    { effect: 'degrades', step: 'click_004', heal: 'promotion' },
    [promote('click_004')],
  ],
  [
    'rename-apply-drop-testid',
    "The 'Apply' button is renamed 'Search' and loses its test id.",
    [rename(at('click_004'), 'Search'), dropAttr(at('click_004'), 'data-testid')],
    { effect: 'fails', step: 'click_004', heal: 'selector' },
    [reselect('click_004', role("button[name='Search']"))],
  ],
  [
    'apply-becomes-plain-element',
    'The Apply button is rebuilt as a styled div with no test id.',
    [retag(at('click_004'), 'div'), dropAttr(at('click_004'), 'data-testid')],
    { effect: 'fails', step: 'click_004', heal: 'selector' },
    [reselect('click_004', text('Apply'))],
  ],
  [
    'apply-in-menu',
    "The Apply button moves into an 'Actions' dropdown.",
    [menu(at('click_004'), 'Actions')],
    { effect: 'fails', step: 'click_004', heal: 'insert_step' },
    [clickFirst('click_004', role("button[name='Actions']"), 'Open the Actions menu.')],
  ],
  [
    'renamed-apply-with-decoy',
    "The Apply button is renamed 'Filter' and loses its test id, and a 'Filter all' button that does the same appears next to it.",
    [
      rename(at('click_004'), 'Filter'),
      dropAttr(at('click_004'), 'data-testid'),
      decoy(at('click_004'), 'Filter all'),
    ],
    { effect: 'fails', step: 'click_004', heal: 'selector', trap: true },
    [reselect('click_004', role("button[name='Filter'][exact=true]"))],
  ],
  [
    'apply-removed',
    'The Apply button is removed; the search no longer filters.',
    [remove(at('click_004'))],
    { effect: 'fails', step: 'click_004', heal: 'not_healable' },
  ],
  // The orders table (extract_005: role table 'Order list', css table.orders).
  [
    'reorder-columns',
    'The orders table shows its columns in reverse order.',
    [{ op: 'reorder_columns', table: 'table.orders', order: [3, 2, 1, 0] }],
    { effect: 'none', heal: 'none' },
  ],
  [
    'rename-total-header',
    "The 'Total' column is renamed 'Amount'.",
    [rename('table.orders th:nth-child(4)', 'Amount')],
    { effect: 'fails', step: 'extract_005', heal: 'not_healable', gap: 'header_alias' },
  ],
  [
    'table-renamed',
    "The orders table's accessible name changes to 'Orders'.",
    [setAttr('table.orders', 'aria-label', 'Orders')],
    { effect: 'fails', step: 'extract_005', heal: 'selector' },
    [reselect('extract_005', role("table[name='Orders']"), css('table.orders'))],
  ],
  [
    'table-renamed-and-restyled',
    "The orders table's accessible name and class both change.",
    [setAttr('table.orders', 'aria-label', 'Orders'), setAttr('table.orders', 'class', 'grid')],
    { effect: 'fails', step: 'extract_005', heal: 'selector' },
    [reselect('extract_005', role("table[name='Orders']"), css('table.grid'))],
  ],
  // The heading (extract_006: css #orders h1).
  [
    'heading-demoted',
    'The orders heading becomes an h2; the heading extract reads nothing.',
    [retag('#orders h1', 'h2')],
    { effect: 'silent', heal: 'none' },
  ],

  // Complex changes.
  [
    'locale-de',
    'The portal switches to German; test ids and classes stay.',
    [
      rename(at('click_002'), 'Bestellungen'),
      rename('label[for="search"]', 'Bestellungen suchen'),
      rename(at('click_004'), 'Anwenden'),
    ],
    {
      effect: 'degrades',
      step: 'click_002',
      steps: ['click_002', 'fill_003', 'click_004'],
      heal: 'promotion',
    },
    [promote('click_002'), promote('fill_003'), promote('click_004')],
  ],
  [
    'locale-de-stripped',
    'The portal switches to German in a redesign that drops test ids and renames classes: three steps need new selectors.',
    [
      rename(at('click_002'), 'Bestellungen'),
      setAttr(at('click_002'), 'class', 'nav-bestellungen'),
      rename('label[for="search"]', 'Bestellungen suchen'),
      dropAttr(at('fill_003'), 'data-testid'),
      rename(at('click_004'), 'Anwenden'),
      dropAttr(at('click_004'), 'data-testid'),
    ],
    { effect: 'fails', step: 'click_002', heal: 'selector' },
    [
      reselect('click_002', role("link[name='Bestellungen']")),
      reselect('fill_003', label('Bestellungen suchen')),
      reselect('click_004', role("button[name='Anwenden']")),
    ],
  ],
  [
    'full-redesign',
    "A redesign: a cookie banner, the navigation folded into a 'Menu' dropdown, and 'Orders' renamed 'Purchases' with a new class. Three heals in a row.",
    [
      rename(at('click_002'), 'Purchases'),
      setAttr(at('click_002'), 'class', 'nav-purchases'),
      menu(at('click_002'), 'Menu'),
      banner('We use cookies', 'Accept all'),
    ],
    { effect: 'fails', step: 'click_002', heal: 'insert_step' },
    [
      clickFirst('click_002', role("button[name='Accept all']"), 'Accept the cookie banner.'),
      clickFirst('click_002', role("button[name='Menu']"), 'Open the menu.'),
      reselect('click_002', role("link[name='Purchases']")),
    ],
  ],
  [
    'intermittent-banner',
    'A cookie banner shows on every other visit.',
    [onLoads([1, 3, 5, 7], [banner('We use cookies', 'Accept all')])],
    { effect: 'fails', step: 'click_002', heal: 'not_healable', gap: 'intermittent' },
  ],
  [
    'ab-test-orders-link',
    "An A/B test: on every other visit the 'Orders' link is renamed 'Purchases' and restyled.",
    [
      onLoads(
        [1, 3, 5, 7],
        [rename(at('click_002'), 'Purchases'), setAttr(at('click_002'), 'class', 'nav-purchases')],
      ),
    ],
    { effect: 'fails', step: 'click_002', heal: 'not_healable', gap: 'ab_test' },
  ],
  [
    'apply-icon-only',
    "The Apply button becomes an icon, labelled 'Apply filter' for assistive technology.",
    [rename(at('click_004'), '⏎'), setAttr(at('click_004'), 'aria-label', 'Apply filter')],
    { effect: 'none', heal: 'none' },
  ],
  [
    'apply-icon-only-renamed',
    "The Apply button becomes an icon labelled 'Run search'.",
    [rename(at('click_004'), '⏎'), setAttr(at('click_004'), 'aria-label', 'Run search')],
    { effect: 'degrades', step: 'click_004', heal: 'promotion' },
    [promote('click_004')],
  ],
  [
    'apply-twin',
    'A second Apply button, identical to the first and to assistive technology, appears after it. Only its position tells them apart.',
    [decoy(at('click_004'), 'Apply', 'after')],
    { effect: 'fails', step: 'click_004', heal: 'selector', trap: true },
    [reselect('click_004', css('#orders form button:first-of-type'))],
  ],
  [
    'apply-in-shadow-dom',
    'The Apply button moves into a web component (open shadow DOM).',
    [shadow(at('click_004'))],
    { effect: 'none', heal: 'none' },
  ],
  [
    'apply-in-iframe',
    'The search controls move into an embedded frame.',
    [iframe(at('click_004'), 'Search controls')],
    { effect: 'fails', step: 'click_004', heal: 'not_healable', gap: 'iframe' },
  ],
  [
    'slow-search-field',
    'The search field renders 0.8 seconds late.',
    [delay(at('fill_003'), 800)],
    { effect: 'none', heal: 'none' },
  ],
  [
    'slow-apply-button',
    // Longer than every candidate's wait together (2 s each, tried in turn):
    // a shorter delay is survived by falling through to the second
    // candidate, and is misreported as a degraded primary selector.
    'The Apply button renders 8 seconds late, longer than the action waits through all its selectors.',
    [delay(at('click_004'), 8000)],
    { effect: 'fails', step: 'click_004', heal: 'insert_step' },
    [
      waitFirst(
        'click_004',
        { selectorVisible: '[data-testid="apply-filter"]' },
        'Wait for the Apply button to render.',
      ),
    ],
  ],
]);

export const SHOP_CASES: DriftCase[] = cases('shop', [
  // The Catalogue link (click_002: role link 'Catalogue', testid nav-catalogue).
  [
    'rename-catalogue',
    "The 'Catalogue' link is renamed 'Products'.",
    [rename(at('click_002'), 'Products')],
    { effect: 'degrades', step: 'click_002', heal: 'promotion' },
    [promote('click_002')],
  ],
  [
    'rename-catalogue-drop-testid',
    "The 'Catalogue' link is renamed 'Products' and loses its test id.",
    [rename(at('click_002'), 'Products'), dropAttr(at('click_002'), 'data-testid')],
    { effect: 'fails', step: 'click_002', heal: 'selector' },
    [reselect('click_002', role("link[name='Products']"))],
  ],
  [
    'catalogue-becomes-button',
    "The 'Catalogue' link is rebuilt as a button.",
    [retag(at('click_002'), 'button')],
    { effect: 'degrades', step: 'click_002', heal: 'promotion' },
    [promote('click_002')],
  ],
  [
    'catalogue-becomes-button-drop-testid',
    "The 'Catalogue' link is rebuilt as a button with no test id.",
    [retag(at('click_002'), 'button'), dropAttr(at('click_002'), 'data-testid')],
    { effect: 'fails', step: 'click_002', heal: 'selector' },
    [reselect('click_002', role("button[name='Catalogue']"))],
  ],
  [
    'catalogue-lowercase',
    "The 'Catalogue' link now reads 'catalogue'.",
    [rename(at('click_002'), 'catalogue')],
    { effect: 'none', heal: 'none' },
  ],
  [
    'catalogue-in-menu',
    "The 'Catalogue' link moves into a 'Menu' dropdown.",
    [menu(at('click_002'), 'Menu')],
    { effect: 'fails', step: 'click_002', heal: 'insert_step' },
    [clickFirst('click_002', role("button[name='Menu']"), 'Open the menu.')],
  ],
  [
    'newsletter-banner',
    "A newsletter sign-up covers the page until 'No thanks' is pressed.",
    [banner('Sign up for our newsletter', 'No thanks')],
    { effect: 'fails', step: 'click_002', heal: 'insert_step' },
    [clickFirst('click_002', role("button[name='No thanks']"), 'Decline the newsletter.')],
  ],
  [
    'cookie-banner-ok',
    "A cookie banner covers the page until 'OK' is pressed.",
    [banner('This site uses cookies', 'OK')],
    { effect: 'fails', step: 'click_002', heal: 'insert_step' },
    [clickFirst('click_002', role("button[name='OK'][exact=true]"), 'Accept the cookie banner.')],
  ],
  // The Garden button (click_003: role button 'Garden', testid cat-garden).
  [
    'rename-garden',
    "The 'Garden' category button is renamed 'Outdoor'.",
    [rename(at('click_003'), 'Outdoor')],
    { effect: 'degrades', step: 'click_003', heal: 'promotion' },
    [promote('click_003')],
  ],
  [
    'rename-garden-drop-testid',
    "The 'Garden' button is renamed 'Outdoor' and loses its test id.",
    [rename(at('click_003'), 'Outdoor'), dropAttr(at('click_003'), 'data-testid')],
    { effect: 'fails', step: 'click_003', heal: 'selector' },
    [reselect('click_003', role("button[name='Outdoor']"))],
  ],
  [
    'renamed-garden-with-decoy',
    "The 'Garden' button is renamed 'Outdoor' and loses its test id, and an 'Outdoor sale' button that shows the same products appears next to it.",
    [
      rename(at('click_003'), 'Outdoor'),
      dropAttr(at('click_003'), 'data-testid'),
      decoy(at('click_003'), 'Outdoor sale'),
    ],
    { effect: 'fails', step: 'click_003', heal: 'selector', trap: true },
    [reselect('click_003', role("button[name='Outdoor'][exact=true]"))],
  ],
  [
    'garden-becomes-plain-element',
    "The 'Garden' button is rebuilt as a styled div with no test id.",
    [retag(at('click_003'), 'div'), dropAttr(at('click_003'), 'data-testid')],
    { effect: 'fails', step: 'click_003', heal: 'selector' },
    [reselect('click_003', text('Garden'))],
  ],
  [
    'garden-in-menu',
    "The 'Garden' button moves into a 'More categories' dropdown.",
    [menu(at('click_003'), 'More categories')],
    { effect: 'fails', step: 'click_003', heal: 'insert_step' },
    [clickFirst('click_003', role("button[name='More categories']"), 'Open more categories.')],
  ],
  [
    'garden-removed',
    "The 'Garden' category is removed.",
    [remove(at('click_003'))],
    { effect: 'fails', step: 'click_003', heal: 'not_healable' },
  ],
  // The postcode field (fill_005: label 'Postcode', css #postcode).
  [
    'postcode-label-longer',
    "The postcode label becomes 'Delivery postcode' (labels match by substring).",
    [rename('label[for="postcode"]', 'Delivery postcode')],
    { effect: 'none', heal: 'none' },
  ],
  [
    'postcode-label-zip',
    "The postcode label becomes 'ZIP'.",
    [rename('label[for="postcode"]', 'ZIP')],
    { effect: 'degrades', step: 'fill_005', heal: 'promotion' },
    [promote('fill_005')],
  ],
  [
    'postcode-label-zip-new-id',
    "The postcode label becomes 'ZIP' and the field's id changes.",
    [
      rename('label[for="postcode"]', 'ZIP'),
      setAttr(at('fill_005'), 'id', 'zip'),
      setAttr('label[for="postcode"]', 'for', 'zip'),
    ],
    { effect: 'fails', step: 'fill_005', heal: 'selector' },
    [reselect('fill_005', label('ZIP'), css('#zip'))],
  ],
  [
    'postcode-removed',
    'The postcode field is removed.',
    [remove(at('fill_005'))],
    { effect: 'fails', step: 'fill_005', heal: 'not_healable' },
  ],
  // The Check delivery button (click_006: role button 'Check delivery', testid check-delivery).
  [
    'rename-check-delivery',
    "The 'Check delivery' button is renamed 'Estimate'.",
    [rename(at('click_006'), 'Estimate')],
    { effect: 'degrades', step: 'click_006', heal: 'promotion' },
    [promote('click_006')],
  ],
  [
    'rename-check-delivery-drop-testid',
    "The 'Check delivery' button is renamed 'Estimate' and loses its test id.",
    [rename(at('click_006'), 'Estimate'), dropAttr(at('click_006'), 'data-testid')],
    { effect: 'fails', step: 'click_006', heal: 'selector' },
    [reselect('click_006', role("button[name='Estimate']"))],
  ],
  [
    'check-delivery-in-menu',
    "The 'Check delivery' button moves into an 'Options' dropdown.",
    [menu(at('click_006'), 'Options')],
    { effect: 'fails', step: 'click_006', heal: 'insert_step' },
    [clickFirst('click_006', role("button[name='Options']"), 'Open the options menu.')],
  ],
  [
    'renamed-check-delivery-with-decoy',
    "The 'Check delivery' button is renamed 'Estimate' and loses its test id, and an 'Estimate shipping' button that does the same appears next to it.",
    [
      rename(at('click_006'), 'Estimate'),
      dropAttr(at('click_006'), 'data-testid'),
      decoy(at('click_006'), 'Estimate shipping'),
    ],
    { effect: 'fails', step: 'click_006', heal: 'selector', trap: true },
    [reselect('click_006', role("button[name='Estimate'][exact=true]"))],
  ],
  // Reads the workflow does not act on (extract_004, extract_007).
  [
    'delivery-result-new-id',
    'The delivery message gets a new id; the delivery extract reads nothing.',
    [setAttr('#delivery-result', 'id', 'delivery-message')],
    { effect: 'silent', heal: 'none' },
  ],
  [
    'product-list-restyled',
    "The product list's class changes; the product extract reads an empty list.",
    [setAttr('ul.products', 'class', 'items')],
    { effect: 'silent', heal: 'none' },
  ],
  [
    'garden-product-heading-demoted',
    "The first garden product's heading becomes an h3; the product extract misses it.",
    [retag('.card[data-category="garden"] h2', 'h3')],
    { effect: 'silent', heal: 'none' },
  ],

  // Complex changes.
  [
    'locale-de',
    'The shop switches to German; test ids and ids stay.',
    [
      rename(at('click_002'), 'Katalog'),
      rename(at('click_003'), 'Garten'),
      rename('label[for="postcode"]', 'Postleitzahl'),
      rename(at('click_006'), 'Lieferung prüfen'),
    ],
    {
      effect: 'degrades',
      step: 'click_002',
      steps: ['click_002', 'click_003', 'fill_005', 'click_006'],
      heal: 'promotion',
    },
    [promote('click_002'), promote('click_003'), promote('fill_005'), promote('click_006')],
  ],
  [
    'redesign',
    "A redesign: a newsletter banner, categories folded into a 'Categories' dropdown, and 'Check delivery' renamed 'Estimate' with no test id. Three heals on three steps.",
    [
      banner('Sign up for our newsletter', 'No thanks'),
      menu(at('click_003'), 'Categories'),
      rename(at('click_006'), 'Estimate'),
      dropAttr(at('click_006'), 'data-testid'),
    ],
    { effect: 'fails', step: 'click_002', heal: 'insert_step' },
    [
      clickFirst('click_002', role("button[name='No thanks']"), 'Decline the newsletter.'),
      clickFirst('click_003', role("button[name='Categories']"), 'Open the categories menu.'),
      reselect('click_006', role("button[name='Estimate']")),
    ],
  ],
  [
    'garden-in-shadow-dom',
    "The 'Garden' button moves into a web component (open shadow DOM).",
    [shadow(at('click_003'))],
    { effect: 'none', heal: 'none' },
  ],
  [
    'ab-test-catalogue',
    "An A/B test: on every other visit the 'Catalogue' link is renamed 'Products' and has no test id.",
    [
      onLoads(
        [1, 3, 5, 7],
        [rename(at('click_002'), 'Products'), dropAttr(at('click_002'), 'data-testid')],
      ),
    ],
    { effect: 'fails', step: 'click_002', heal: 'not_healable', gap: 'ab_test' },
  ],
  [
    'intermittent-newsletter',
    'A newsletter sign-up shows on every other visit.',
    [onLoads([1, 3, 5, 7], [banner('Sign up for our newsletter', 'No thanks')])],
    { effect: 'fails', step: 'click_002', heal: 'not_healable', gap: 'intermittent' },
  ],
  [
    'slow-product-list',
    'The product list renders 3 seconds late; the product extract reads an empty list before it arrives.',
    [delay('ul.products', 3000)],
    { effect: 'silent', heal: 'none' },
  ],
]);

/** Every case, both fixtures. */
export const ALL_CASES: DriftCase[] = [...PORTAL_CASES, ...SHOP_CASES];
