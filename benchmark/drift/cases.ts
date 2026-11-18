// Drift cases: named, reproducible site changes on a fixture, each with
// what it is expected to do to the fixture's workflow. The self-tests
// (`drift.test.ts`) hold every case to its expectation, so a case that
// stops breaking what it claims to break is caught before it skews a
// measurement.
//
// This is the starting set that exercises every operator. The 50+ case
// suite for measuring the false-heal rate builds on it.

import type { Drift } from './drift.js';

export interface DriftCase {
  id: string;
  /** What the change is, as a site owner would describe it. */
  description: string;
  fixture: string;
  drifts: Drift[];
  expect: {
    /**
     * What the drift does to the original workflow:
     * - `fails`: the run fails even with selector fallback.
     * - `degrades`: the run passes, but only on a fallback selector.
     * - `none`: the workflow copes (the case documents a robustness).
     */
    effect: 'fails' | 'degrades' | 'none';
    /** The step that breaks: where the run fails, or which step degrades. */
    step?: string;
    /**
     * The heal that would be right:
     * - `promotion`: move the working fallback to the front (no model).
     * - `selector`: new selectors for the step.
     * - `insert_step`: one click before the step (open a menu, dismiss a banner).
     * - `not_healable`: no allowed patch can restore the workflow; the
     *   healer should say so rather than produce one.
     * - `none`: nothing to heal.
     */
    heal: 'promotion' | 'selector' | 'insert_step' | 'not_healable' | 'none';
    /**
     * A decoy that behaves like the real element is on the page. A heal
     * that picks it passes verification with identical outputs; only the
     * truth markers show it is wrong.
     */
    trap?: boolean;
  };
}

export const PORTAL_CASES: DriftCase[] = [
  {
    id: 'portal-rename-orders-link',
    description: "The 'Orders' link is renamed 'Purchases'.",
    fixture: 'portal',
    drifts: [{ op: 'rename_text', selector: 'nav a.nav-orders', text: 'Purchases' }],
    expect: { effect: 'degrades', step: 'click_002', heal: 'promotion' },
  },
  {
    id: 'portal-rename-and-restyle-orders-link',
    description: "The 'Orders' link is renamed 'Purchases' and its class changes.",
    fixture: 'portal',
    drifts: [
      { op: 'rename_text', selector: 'nav a.nav-orders', text: 'Purchases' },
      { op: 'set_attribute', selector: 'nav a.nav-orders', name: 'class', value: 'nav-purchases' },
    ],
    expect: { effect: 'fails', step: 'click_002', heal: 'selector' },
  },
  {
    id: 'portal-relabel-search',
    description: "The search box's label changes to 'Find an order'.",
    fixture: 'portal',
    drifts: [{ op: 'rename_text', selector: 'label[for="search"]', text: 'Find an order' }],
    expect: { effect: 'degrades', step: 'fill_003', heal: 'promotion' },
  },
  {
    id: 'portal-apply-becomes-plain-element',
    description: 'The Apply button is rebuilt as a styled div with no test id.',
    fixture: 'portal',
    drifts: [
      { op: 'retag', selector: '[data-testid="apply-filter"]', tag: 'div' },
      { op: 'remove_attribute', selector: '[data-sfysh-truth="click_004"]', name: 'data-testid' },
    ],
    expect: { effect: 'fails', step: 'click_004', heal: 'selector' },
  },
  {
    id: 'portal-reorder-columns',
    description: 'The orders table shows its columns in reverse order.',
    fixture: 'portal',
    drifts: [{ op: 'reorder_columns', table: 'table.orders', order: [3, 2, 1, 0] }],
    expect: { effect: 'none', heal: 'none' },
  },
  {
    id: 'portal-rename-total-header',
    description: "The 'Total' column is renamed 'Amount'.",
    fixture: 'portal',
    drifts: [{ op: 'rename_text', selector: 'table.orders th:nth-child(4)', text: 'Amount' }],
    expect: { effect: 'fails', step: 'extract_005', heal: 'not_healable' },
  },
  {
    id: 'portal-cookie-banner',
    description: 'A cookie banner now covers the page until accepted.',
    fixture: 'portal',
    drifts: [{ op: 'add_overlay', text: 'We use cookies', dismissLabel: 'Accept all' }],
    expect: { effect: 'fails', step: 'click_002', heal: 'insert_step' },
  },
  {
    id: 'portal-orders-in-menu',
    description: "The 'Orders' link moves into a 'More' dropdown.",
    fixture: 'portal',
    drifts: [{ op: 'wrap_in_menu', selector: 'nav a.nav-orders', menuLabel: 'More' }],
    expect: { effect: 'fails', step: 'click_002', heal: 'insert_step' },
  },
  {
    id: 'portal-renamed-link-with-decoy',
    description:
      "The 'Orders' link is renamed 'Purchases' and restyled, and an 'Order archive' link that opens the same page appears next to it.",
    fixture: 'portal',
    drifts: [
      { op: 'rename_text', selector: 'nav a.nav-orders', text: 'Purchases' },
      { op: 'set_attribute', selector: 'nav a.nav-orders', name: 'class', value: 'nav-purchases' },
      {
        op: 'add_decoy',
        selector: 'nav a.nav-purchases',
        text: 'Order archive',
        position: 'before',
      },
    ],
    expect: { effect: 'fails', step: 'click_002', heal: 'selector', trap: true },
  },
  {
    id: 'portal-apply-removed',
    description: 'The Apply button is removed; the search no longer filters.',
    fixture: 'portal',
    drifts: [{ op: 'remove', selector: '[data-testid="apply-filter"]' }],
    expect: { effect: 'fails', step: 'click_004', heal: 'not_healable' },
  },
];
