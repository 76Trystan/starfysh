// Held-out drift cases, set h2: site changes on the supplier portal fixture
// that no prompt or scorer change is ever tuned against. h1 (42 cases) is
// under the 50 synthetic changes a published false-heal rate is meant to
// rest on, so h2 is written to meet that on its own rather than by adding
// the two sets together. See `suites.ts` for the roles and `case-sets.ts`
// for the rule that keeps models off this file until it is frozen.
//
// Written from 2026-11-24, after the first model run on h1, with the
// healer and its prompt unchanged since then. h1's results showed where
// the healer is weak (semantic decoys, twins, elements that lose their
// role, late rendering). So that h2 neither avoids nor piles onto those
// cases, its mix was fixed before any case was written, as h1's
// proportions scaled by about 1.25:
//
//   healable        34+  (16 selector, 10 promotion, 8 insert_step)
//   decoy traps      5+  (2 semantic, 2 textual, 1 twin, as in h1)
//   not healable    10   (gaps and removals)
//   robustness and silent  8
//
// `drift.test.ts` holds the set to that mix.
//
// How the fixture differs from the bank, and so what these cases test:
// - Every step the workflow acts on has a working look-alike beside it
//   (Northwind Paper Co, Delivered since, Minimum quantity, Clear filters).
//   A refusal case whose element is removed leaves its look-alike working,
//   so a guess there gives a wrong answer that runs.
// - The page reads table cells by header name, so reordered columns are a
//   change the workflow should survive, which the bank could not test.
// - One silent case is a form whose two date labels are swapped: the
//   workflow fills the wrong field by its own primary selector and passes.

import type { SuiteCase } from './case-kit.js';
import {
  at,
  banner,
  cases,
  clickFirst,
  css,
  decoy,
  delay,
  dropAttr,
  iframe,
  label,
  menu,
  onLoads,
  promote,
  remove,
  rename,
  reorderColumns,
  reselect,
  retag,
  role,
  setAttr,
  shadow,
  testid,
  text,
  waitFirst,
} from './case-kit.js';

export const SUPPLIER_CASES: SuiteCase[] = [
  ...cases('suppliers', 'simple', [
    // The Purchase orders link (click_002: role link 'Purchase orders', testid nav-orders).
    [
      'rename-orders',
      "The 'Purchase orders' link is renamed 'Orders'.",
      [rename(at('click_002'), 'Orders')],
      { effect: 'degrades', step: 'click_002', heal: 'promotion' },
      [promote('click_002')],
    ],
    [
      'rename-orders-drop-testid',
      "The 'Purchase orders' link is renamed 'Buying' and loses its test id.",
      [rename(at('click_002'), 'Buying'), dropAttr(at('click_002'), 'data-testid')],
      { effect: 'fails', step: 'click_002', heal: 'selector' },
      [reselect('click_002', role("link[name='Buying']"))],
    ],
    [
      'orders-becomes-button',
      "The 'Purchase orders' link is rebuilt as a button; its test id stays.",
      [retag(at('click_002'), 'button')],
      { effect: 'degrades', step: 'click_002', heal: 'promotion' },
      [promote('click_002')],
    ],
    [
      'orders-longer-name',
      "The 'Purchase orders' link now reads 'Purchase orders and receipts' (role names match by substring).",
      [rename(at('click_002'), 'Purchase orders and receipts')],
      { effect: 'none', heal: 'none' },
    ],
    [
      'orders-in-menu',
      "The 'Purchase orders' link moves into a 'Procurement' dropdown.",
      [menu(at('click_002'), 'Procurement')],
      { effect: 'fails', step: 'click_002', heal: 'insert_step' },
      [clickFirst('click_002', role("button[name='Procurement']"), 'Open the Procurement menu.')],
    ],
    [
      'renamed-orders-with-decoy',
      "The 'Purchase orders' link is renamed 'Orders' and loses its test id, and an 'Orders archive' link that opens the same page appears before it.",
      [
        rename(at('click_002'), 'Orders'),
        dropAttr(at('click_002'), 'data-testid'),
        decoy(at('click_002'), 'Orders archive'),
      ],
      { effect: 'fails', step: 'click_002', heal: 'selector', trap: true },
      [reselect('click_002', role("link[name='Orders'][exact=true]"))],
    ],
    [
      'renamed-orders-with-semantic-decoy',
      "The 'Purchase orders' link is renamed 'POs' and loses its test id, and a 'Requisitions' link that opens the same page appears before it.",
      [
        rename(at('click_002'), 'POs'),
        dropAttr(at('click_002'), 'data-testid'),
        decoy(at('click_002'), 'Requisitions'),
      ],
      { effect: 'fails', step: 'click_002', heal: 'selector', trap: true },
      [reselect('click_002', role("link[name='POs']"))],
    ],
    [
      'orders-removed',
      "The 'Purchase orders' link is removed; orders cannot be reached.",
      [remove(at('click_002'))],
      { effect: 'fails', step: 'click_002', heal: 'not_healable' },
    ],
    // Banners covering the page before the first click.
    [
      'cookie-banner',
      "A cookie notice covers the page until 'Accept cookies' is pressed.",
      [banner('We use cookies to keep you signed in', 'Accept cookies')],
      { effect: 'fails', step: 'click_002', heal: 'insert_step' },
      [clickFirst('click_002', role("button[name='Accept cookies']"), 'Accept the cookie notice.')],
    ],
    [
      'maintenance-notice',
      "A maintenance notice covers the page until 'Dismiss' is pressed.",
      [banner('Scheduled maintenance on Sunday from 2am to 4am', 'Dismiss')],
      { effect: 'fails', step: 'click_002', heal: 'insert_step' },
      [clickFirst('click_002', role("button[name='Dismiss']"), 'Dismiss the maintenance notice.')],
    ],
    // The Northwind Packaging link (click_003: role link 'Northwind Packaging',
    // testid supplier-northwind-packaging), beside a Northwind Paper Co link
    // that works the same way and gives different order lines.
    [
      'supplier-name-longer',
      "The supplier link now reads 'Northwind Packaging Ltd'.",
      [rename(at('click_003'), 'Northwind Packaging Ltd')],
      { effect: 'none', heal: 'none' },
    ],
    [
      'supplier-name-shortened',
      "The supplier link is shortened to 'Northwind Pack.'.",
      [rename(at('click_003'), 'Northwind Pack.')],
      { effect: 'degrades', step: 'click_003', heal: 'promotion' },
      [promote('click_003')],
    ],
    [
      'supplier-renamed-drop-testid',
      "The supplier link is renamed 'NW Packaging' and loses its test id.",
      [rename(at('click_003'), 'NW Packaging'), dropAttr(at('click_003'), 'data-testid')],
      { effect: 'fails', step: 'click_003', heal: 'selector' },
      [reselect('click_003', role("link[name='NW Packaging']"))],
    ],
    [
      'renamed-supplier-with-decoy',
      "The supplier link is renamed 'Northwind Pkg' and loses its test id, and a 'Northwind Pkg (archived)' link that selects the same supplier appears before it.",
      [
        rename(at('click_003'), 'Northwind Pkg'),
        dropAttr(at('click_003'), 'data-testid'),
        decoy(at('click_003'), 'Northwind Pkg (archived)'),
      ],
      { effect: 'fails', step: 'click_003', heal: 'selector', trap: true },
      [reselect('click_003', role("link[name='Northwind Pkg'][exact=true]"))],
    ],
    [
      'supplier-becomes-button',
      'The supplier link is rebuilt as a button; its test id stays.',
      [retag(at('click_003'), 'button')],
      { effect: 'degrades', step: 'click_003', heal: 'promotion' },
      [promote('click_003')],
    ],
    [
      'supplier-becomes-plain-element',
      'The supplier link is rebuilt as a styled span with no test id.',
      [retag(at('click_003'), 'span'), dropAttr(at('click_003'), 'data-testid')],
      { effect: 'fails', step: 'click_003', heal: 'selector' },
      [reselect('click_003', text('Northwind Packaging'))],
    ],
    [
      'suppliers-in-menu',
      "The supplier list moves into a 'Choose supplier' dropdown.",
      [menu('ul.suppliers', 'Choose supplier')],
      { effect: 'fails', step: 'click_003', heal: 'insert_step' },
      [
        clickFirst(
          'click_003',
          role("button[name='Choose supplier']"),
          'Open the supplier chooser.',
        ),
      ],
    ],
    [
      'supplier-removed',
      'Northwind Packaging is removed from the supplier list. The Northwind Paper Co link still works, and choosing it would be wrong.',
      [remove(at('click_003'))],
      { effect: 'fails', step: 'click_003', heal: 'not_healable' },
    ],
    // The Ordered since field (fill_004: label 'Ordered since', css
    // #ordered-since), beside a Delivered since field with the same placeholder.
    [
      'relabel-ordered',
      "The 'Ordered since' label changes to 'Order date from'.",
      [rename('label[for="ordered-since"]', 'Order date from')],
      { effect: 'degrades', step: 'fill_004', heal: 'promotion' },
      [promote('fill_004')],
    ],
    [
      'relabel-ordered-new-id',
      "The 'Ordered since' label changes to 'Placed after' and the field's id changes.",
      [
        rename('label[for="ordered-since"]', 'Placed after'),
        setAttr(at('fill_004'), 'id', 'placed-after'),
        setAttr('label[for="ordered-since"]', 'for', 'placed-after'),
      ],
      { effect: 'fails', step: 'fill_004', heal: 'selector' },
      [reselect('fill_004', label('Placed after'), css('#placed-after'))],
    ],
    [
      'ordered-label-removed',
      "The 'Ordered since' label is removed and the field's id changes. Only its test id tells it from the Delivered since field; both share a placeholder.",
      [remove('label[for="ordered-since"]'), setAttr(at('fill_004'), 'id', 'po-date-start')],
      { effect: 'fails', step: 'fill_004', heal: 'selector' },
      [reselect('fill_004', testid('filter-ordered-since'))],
    ],
    [
      'filters-in-panel',
      "The filter fields move into a collapsed 'Filters' panel.",
      [menu('form.filters', 'Filters')],
      { effect: 'fails', step: 'fill_004', heal: 'insert_step' },
      [
        clickFirst(
          'fill_004',
          role("button[name='Filters'][exact=true]"),
          'Open the Filters panel.',
        ),
      ],
    ],
    [
      'ordered-field-removed',
      'The Ordered since field is removed. The Delivered since field still works, and filling it would be wrong.',
      [remove(at('fill_004'))],
      { effect: 'fails', step: 'fill_004', heal: 'not_healable' },
    ],
    // The Minimum line total field (fill_005: label 'Minimum line total', css
    // #min-total), beside a Minimum quantity field with the same placeholder.
    [
      'relabel-min-total',
      "The 'Minimum line total' label changes to 'Minimum value'.",
      [rename('label[for="min-total"]', 'Minimum value')],
      { effect: 'degrades', step: 'fill_005', heal: 'promotion' },
      [promote('fill_005')],
    ],
    [
      'relabel-min-total-new-id',
      "The 'Minimum line total' label changes to 'Lines worth at least' and the field's id changes.",
      [
        rename('label[for="min-total"]', 'Lines worth at least'),
        setAttr(at('fill_005'), 'id', 'line-floor'),
        setAttr('label[for="min-total"]', 'for', 'line-floor'),
      ],
      { effect: 'fails', step: 'fill_005', heal: 'selector' },
      [reselect('fill_005', label('Lines worth at least'), css('#line-floor'))],
    ],
    [
      'min-total-label-longer',
      "The 'Minimum line total' label now reads 'Minimum line total (AUD)'.",
      [rename('label[for="min-total"]', 'Minimum line total (AUD)')],
      { effect: 'none', heal: 'none' },
    ],
    [
      'min-total-field-removed',
      'The Minimum line total field is removed. The Minimum quantity field still works, and filling it would be wrong.',
      [remove(at('fill_005'))],
      { effect: 'fails', step: 'fill_005', heal: 'not_healable' },
    ],
    // The Apply filters button (click_006: role button 'Apply filters', testid
    // apply-filters), beside a Clear filters button.
    [
      'rename-apply',
      "The 'Apply filters' button is renamed 'Apply'.",
      [rename(at('click_006'), 'Apply')],
      { effect: 'degrades', step: 'click_006', heal: 'promotion' },
      [promote('click_006')],
    ],
    [
      'rename-apply-drop-testid',
      "The 'Apply filters' button is renamed 'Search' and loses its test id.",
      [rename(at('click_006'), 'Search'), dropAttr(at('click_006'), 'data-testid')],
      { effect: 'fails', step: 'click_006', heal: 'selector' },
      [reselect('click_006', role("button[name='Search']"))],
    ],
    [
      'apply-becomes-link',
      "The 'Apply filters' button is rebuilt as a plain anchor with no href; its test id stays.",
      [retag(at('click_006'), 'a')],
      { effect: 'degrades', step: 'click_006', heal: 'promotion' },
      [promote('click_006')],
    ],
    [
      'apply-icon-only',
      "The 'Apply filters' button becomes an icon, labelled 'Apply filters to the order list' for assistive technology.",
      [
        rename(at('click_006'), '✓'),
        setAttr(at('click_006'), 'aria-label', 'Apply filters to the order list'),
      ],
      { effect: 'none', heal: 'none' },
    ],
    [
      'apply-icon-only-renamed',
      "The 'Apply filters' button becomes an icon labelled 'Filter'.",
      [rename(at('click_006'), '✓'), setAttr(at('click_006'), 'aria-label', 'Filter')],
      { effect: 'degrades', step: 'click_006', heal: 'promotion' },
      [promote('click_006')],
    ],
    [
      'apply-in-menu',
      "The 'Apply filters' button moves into an 'Actions' dropdown.",
      [menu(at('click_006'), 'Actions')],
      { effect: 'fails', step: 'click_006', heal: 'insert_step' },
      [clickFirst('click_006', role("button[name='Actions']"), 'Open the Actions menu.')],
    ],
    [
      'renamed-apply-with-semantic-decoy',
      "The 'Apply filters' button is renamed 'Go' and loses its test id, and a 'Refresh list' button that does the same appears before it.",
      [
        rename(at('click_006'), 'Go'),
        dropAttr(at('click_006'), 'data-testid'),
        decoy(at('click_006'), 'Refresh list'),
      ],
      { effect: 'fails', step: 'click_006', heal: 'selector', trap: true },
      [reselect('click_006', role("button[name='Go'][exact=true]"))],
    ],
    [
      'apply-removed',
      'The Apply filters button is removed. The Clear filters button still works, and pressing it would be wrong.',
      [remove(at('click_006'))],
      { effect: 'fails', step: 'click_006', heal: 'not_healable' },
    ],
    // The order lines table (extract_007: role table 'Order lines', css table.order-lines).
    [
      'table-renamed',
      // Fails rather than degrades, as in v1 and h1: a table extract whose
      // role candidate matches nothing does not try its css candidate.
      "The order lines table's accessible name changes to 'Lines'.",
      [setAttr('table.order-lines', 'aria-label', 'Lines')],
      { effect: 'fails', step: 'extract_007', heal: 'selector' },
      [reselect('extract_007', role("table[name='Lines']"), css('table.order-lines'))],
    ],
    [
      'table-renamed-and-restyled',
      "The order lines table's accessible name and class both change.",
      [
        setAttr('table.order-lines', 'aria-label', 'Lines'),
        setAttr('table.order-lines', 'class', 'po-lines'),
      ],
      { effect: 'fails', step: 'extract_007', heal: 'selector' },
      [reselect('extract_007', role("table[name='Lines']"), css('table.po-lines'))],
    ],
    [
      'columns-reordered',
      'The order lines columns are reordered. The page and the extract both read columns by header.',
      [reorderColumns('table.order-lines', [3, 0, 5, 1, 4, 2])],
      { effect: 'none', heal: 'none' },
    ],
    [
      'rename-item-header',
      "The 'Item' column is renamed 'Description'.",
      [rename('table.order-lines th:nth-child(2)', 'Description')],
      { effect: 'fails', step: 'extract_007', heal: 'not_healable', gap: 'header_alias' },
    ],
    // The order total (extract_008: css #order-total).
    [
      'total-new-id',
      'The order total gets a new id; the total extract reads nothing.',
      [setAttr('#order-total', 'id', 'po-total')],
      { effect: 'silent', heal: 'none' },
    ],
    [
      'date-labels-swapped',
      "The 'Ordered since' and 'Delivered since' labels are swapped by mistake. The workflow's label selector now finds the delivery date field, fills it, and the run passes with different order lines.",
      [
        rename('label[for="ordered-since"]', 'Delivered since'),
        rename('label[for="delivered-since"]', 'Ordered since'),
      ],
      { effect: 'silent', heal: 'none' },
    ],
  ]),
  // Complex changes.
  ...cases('suppliers', 'complex', [
    [
      'locale-de',
      // Four promotions, the harness's default heal cap (heal-run.ts).
      'The portal switches to German; test ids and ids stay, and supplier names, the table name and its headers stay in English.',
      [
        rename(at('click_002'), 'Bestellungen'),
        rename('label[for="ordered-since"]', 'Bestellt seit'),
        rename('label[for="delivered-since"]', 'Geliefert seit'),
        rename('label[for="min-total"]', 'Mindestbetrag je Position'),
        rename('label[for="min-qty"]', 'Mindestmenge'),
        rename(at('click_006'), 'Filter anwenden'),
        rename('[data-testid="clear-filters"]', 'Filter löschen'),
      ],
      {
        effect: 'degrades',
        step: 'click_002',
        steps: ['click_002', 'fill_004', 'fill_005', 'click_006'],
        heal: 'promotion',
      },
      [promote('click_002'), promote('fill_004'), promote('fill_005'), promote('click_006')],
    ],
    [
      'redesign',
      "A redesign: a terms notice, the supplier list folded into a 'Choose supplier' dropdown, and 'Apply filters' renamed 'Run' with no test id. Three heals on three steps.",
      [
        banner('We have updated our supplier terms', 'Accept'),
        menu('ul.suppliers', 'Choose supplier'),
        rename(at('click_006'), 'Run'),
        dropAttr(at('click_006'), 'data-testid'),
      ],
      { effect: 'fails', step: 'click_002', heal: 'insert_step' },
      [
        clickFirst(
          'click_002',
          role("button[name='Accept'][exact=true]"),
          'Accept the supplier terms notice.',
        ),
        clickFirst(
          'click_003',
          role("button[name='Choose supplier']"),
          'Open the supplier chooser.',
        ),
        reselect('click_006', role("button[name='Run']")),
      ],
    ],
    [
      'filter-labels-reworded',
      "The two filters the workflow fills are relabelled 'Order placed from' and 'Line value from' and both get new ids. Two heals, on fields whose look-alikes (Delivered since, Minimum quantity) sit beside them; filling a look-alike changes the order lines.",
      [
        rename('label[for="ordered-since"]', 'Order placed from'),
        setAttr(at('fill_004'), 'id', 'placed-from'),
        setAttr('label[for="ordered-since"]', 'for', 'placed-from'),
        rename('label[for="min-total"]', 'Line value from'),
        setAttr(at('fill_005'), 'id', 'value-from'),
        setAttr('label[for="min-total"]', 'for', 'value-from'),
      ],
      { effect: 'fails', step: 'fill_004', heal: 'selector' },
      [
        reselect('fill_004', label('Order placed from'), css('#placed-from')),
        reselect('fill_005', label('Line value from'), css('#value-from')),
      ],
    ],
    [
      'orders-area-renamed',
      "The orders area is renamed: the 'Purchase orders' link becomes 'Procurement' with no test id, and the order lines table's accessible name becomes 'Lines'. Two heals, on a click and an extract.",
      [
        rename(at('click_002'), 'Procurement'),
        dropAttr(at('click_002'), 'data-testid'),
        setAttr('table.order-lines', 'aria-label', 'Lines'),
      ],
      { effect: 'fails', step: 'click_002', heal: 'selector' },
      [
        reselect('click_002', role("link[name='Procurement']")),
        reselect('extract_007', role("table[name='Lines']"), css('table.order-lines')),
      ],
    ],
    [
      'apply-twin',
      'A second Apply filters button, identical to the first and to assistive technology, appears after it. Only its position tells them apart.',
      [decoy(at('click_006'), 'Apply filters', 'after')],
      { effect: 'fails', step: 'click_006', heal: 'selector', trap: true },
      [reselect('click_006', css('form.filters button:first-of-type'))],
    ],
    [
      'slow-supplier-link',
      // Longer than every candidate's wait together (2 s each, tried in
      // turn), for the reason given on v1's slow-apply-button.
      'The Northwind Packaging link renders 8 seconds late, longer than the action waits through all its selectors.',
      [delay(at('click_003'), 8000)],
      { effect: 'fails', step: 'click_003', heal: 'insert_step' },
      [
        waitFirst(
          'click_003',
          { selectorVisible: '[data-testid="supplier-northwind-packaging"]' },
          'Wait for the Northwind Packaging link to render.',
        ),
      ],
    ],
    [
      'intermittent-survey-banner',
      'A supplier survey covers the page on every other visit.',
      [onLoads([1, 3, 5, 7], [banner('How are we doing? Take our 2-minute survey', 'Not now')])],
      { effect: 'fails', step: 'click_002', heal: 'not_healable', gap: 'intermittent' },
    ],
    [
      'ab-test-orders',
      "An A/B test: on every other visit the 'Purchase orders' link is renamed 'Buying' and has no test id.",
      [
        onLoads(
          [1, 3, 5, 7],
          [rename(at('click_002'), 'Buying'), dropAttr(at('click_002'), 'data-testid')],
        ),
      ],
      { effect: 'fails', step: 'click_002', heal: 'not_healable', gap: 'ab_test' },
    ],
    [
      'ab-test-apply',
      "An A/B test: on every other visit the 'Apply filters' button is renamed 'Search' and has no test id.",
      [
        onLoads(
          [1, 3, 5, 7],
          [rename(at('click_006'), 'Search'), dropAttr(at('click_006'), 'data-testid')],
        ),
      ],
      { effect: 'fails', step: 'click_006', heal: 'not_healable', gap: 'ab_test' },
    ],
    [
      'ordered-field-in-iframe',
      'The Ordered since field moves into an embedded frame.',
      [iframe(at('fill_004'), 'Order date filter')],
      { effect: 'fails', step: 'fill_004', heal: 'not_healable', gap: 'iframe' },
    ],
    [
      'apply-in-shadow-dom',
      "The 'Apply filters' button moves into a web component (open shadow DOM).",
      [shadow(at('click_006'))],
      { effect: 'none', heal: 'none' },
    ],
  ]),
];

/** Every case in set h2. */
export const H2_CASES: SuiteCase[] = [...SUPPLIER_CASES];
