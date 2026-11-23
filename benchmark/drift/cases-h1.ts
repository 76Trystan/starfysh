// Held-out drift cases, set h1: site changes on the bank fixture that no
// prompt or scorer change is ever tuned against. The published headline
// rate comes from a held-out set; v1 (`cases.ts`) is the tuning set and is
// reported beside it, labelled as such. See `suites.ts` for the roles and
// `case-sets.ts` for the rule that keeps models off this file until it is
// frozen.
//
// Written on 2026-11-23, before any model has seen the bank fixture. The
// same self-tests as v1 (`drift.test.ts`) hold every case to its expected
// effect and prove every oracle passes the healer's own rules and is
// judged correct.
//
// How it differs from v1, on purpose:
// - Look-alikes are part of the page, not only added by a drift: two
//   account buttons and two date fields with near-identical labels. Picking
//   the wrong one changes the outputs, so these test the healer's choice
//   even where verification would catch a mistake.
// - Two decoy traps are semantic rather than textual: the decoy's name does
//   not contain the real element's name ('Account activity' beside a
//   renamed Statements link, 'Main account' beside a renamed Everyday
//   account). A selector cannot be ambiguous between them; only reading the
//   step's intent tells them apart.
// - One field loses its label altogether, leaving a test id and a
//   placeholder that both date fields share.
// - The refusal cases include one with a tempting wrong answer: with the
//   Everyday account removed, the Savings account button still works.
//
// Not covered, and why: column reordering breaks the fixture's own script
// (it reads cells by position, as many real sites do), so it would test the
// fixture rather than the healer.

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
  reselect,
  retag,
  role,
  setAttr,
  shadow,
  testid,
  text,
  waitFirst,
} from './case-kit.js';

export const BANK_CASES: SuiteCase[] = [
  ...cases('bank', 'simple', [
    // The Statements link (click_002: role link 'Statements', testid nav-statements).
    [
      'rename-statements',
      "The 'Statements' link is renamed 'Documents'.",
      [rename(at('click_002'), 'Documents')],
      { effect: 'degrades', step: 'click_002', heal: 'promotion' },
      [promote('click_002')],
    ],
    [
      'rename-statements-drop-testid',
      "The 'Statements' link is renamed 'History' and loses its test id.",
      [rename(at('click_002'), 'History'), dropAttr(at('click_002'), 'data-testid')],
      { effect: 'fails', step: 'click_002', heal: 'selector' },
      [reselect('click_002', role("link[name='History']"))],
    ],
    [
      'statements-becomes-button',
      "The 'Statements' link is rebuilt as a button; its test id stays.",
      [retag(at('click_002'), 'button')],
      { effect: 'degrades', step: 'click_002', heal: 'promotion' },
      [promote('click_002')],
    ],
    [
      'statements-estatements',
      "The 'Statements' link now reads 'eStatements' (role names match by substring).",
      [rename(at('click_002'), 'eStatements')],
      { effect: 'none', heal: 'none' },
    ],
    [
      'statements-in-menu',
      "The 'Statements' link moves into an 'Accounts' dropdown.",
      [menu(at('click_002'), 'Accounts')],
      { effect: 'fails', step: 'click_002', heal: 'insert_step' },
      [clickFirst('click_002', role("button[name='Accounts']"), 'Open the Accounts menu.')],
    ],
    [
      'renamed-statements-with-decoy',
      "The 'Statements' link is renamed 'Documents' and loses its test id, and an 'Account activity' link that opens the same page appears before it.",
      [
        rename(at('click_002'), 'Documents'),
        dropAttr(at('click_002'), 'data-testid'),
        decoy(at('click_002'), 'Account activity'),
      ],
      { effect: 'fails', step: 'click_002', heal: 'selector', trap: true },
      [reselect('click_002', role("link[name='Documents']"))],
    ],
    [
      'statements-removed',
      "The 'Statements' link is removed; statements cannot be reached.",
      [remove(at('click_002'))],
      { effect: 'fails', step: 'click_002', heal: 'not_healable' },
    ],
    // Banners covering the page before the first click.
    [
      'session-banner',
      "A session warning covers the page until 'Stay signed in' is pressed.",
      [banner('Your session will expire in 2 minutes', 'Stay signed in')],
      { effect: 'fails', step: 'click_002', heal: 'insert_step' },
      [
        clickFirst(
          'click_002',
          role("button[name='Stay signed in']"),
          'Dismiss the session warning.',
        ),
      ],
    ],
    [
      'security-notice',
      "A security notice covers the page until 'I understand' is pressed.",
      [banner('Please review our updated security tips', 'I understand')],
      { effect: 'fails', step: 'click_002', heal: 'insert_step' },
      [
        clickFirst(
          'click_002',
          role("button[name='I understand']"),
          'Dismiss the security notice.',
        ),
      ],
    ],
    // The Everyday account button (click_003: role button 'Everyday account',
    // testid acct-everyday), beside a Savings account button that works the
    // same way and gives a different statement.
    [
      'rename-everyday',
      "The 'Everyday account' button now reads 'Everyday'.",
      [rename(at('click_003'), 'Everyday')],
      { effect: 'degrades', step: 'click_003', heal: 'promotion' },
      [promote('click_003')],
    ],
    [
      'rename-everyday-drop-testid',
      "The 'Everyday account' button is renamed 'Spending account' and loses its test id.",
      [rename(at('click_003'), 'Spending account'), dropAttr(at('click_003'), 'data-testid')],
      { effect: 'fails', step: 'click_003', heal: 'selector' },
      [reselect('click_003', role("button[name='Spending account']"))],
    ],
    [
      'renamed-everyday-with-decoy',
      "The 'Everyday account' button is renamed 'Transaction account' and loses its test id, and a 'Main account' button that selects the same account appears before it.",
      [
        rename(at('click_003'), 'Transaction account'),
        dropAttr(at('click_003'), 'data-testid'),
        decoy(at('click_003'), 'Main account'),
      ],
      { effect: 'fails', step: 'click_003', heal: 'selector', trap: true },
      [reselect('click_003', role("button[name='Transaction account']"))],
    ],
    [
      'accounts-in-menu',
      "Both account buttons move into a 'Choose account' dropdown.",
      [menu('div[role="group"]', 'Choose account')],
      { effect: 'fails', step: 'click_003', heal: 'insert_step' },
      [clickFirst('click_003', role("button[name='Choose account']"), 'Open the account chooser.')],
    ],
    [
      'everyday-becomes-plain-element',
      "The 'Everyday account' button is rebuilt as a styled div with no test id.",
      [retag(at('click_003'), 'div'), dropAttr(at('click_003'), 'data-testid')],
      { effect: 'fails', step: 'click_003', heal: 'selector' },
      [reselect('click_003', text('Everyday account'))],
    ],
    [
      'everyday-uppercase',
      "The 'Everyday account' button now reads 'EVERYDAY ACCOUNT'.",
      [rename(at('click_003'), 'EVERYDAY ACCOUNT')],
      { effect: 'none', heal: 'none' },
    ],
    [
      'everyday-removed',
      'The Everyday account is closed and its button removed. The Savings account button still works, and choosing it would be wrong.',
      [remove(at('click_003'))],
      { effect: 'fails', step: 'click_003', heal: 'not_healable' },
    ],
    // The From date field (fill_004: label 'From date', css #from).
    [
      'relabel-from',
      "The 'From date' label changes to 'Start date'.",
      [rename('label[for="from"]', 'Start date')],
      { effect: 'degrades', step: 'fill_004', heal: 'promotion' },
      [promote('fill_004')],
    ],
    [
      'relabel-from-new-id',
      "The 'From date' label changes to 'Start date' and the field's id changes.",
      [
        rename('label[for="from"]', 'Start date'),
        setAttr(at('fill_004'), 'id', 'start'),
        setAttr('label[for="from"]', 'for', 'start'),
      ],
      { effect: 'fails', step: 'fill_004', heal: 'selector' },
      [reselect('fill_004', label('Start date'), css('#start'))],
    ],
    [
      'from-label-removed',
      "The 'From date' label is removed and the field's id changes. Only its test id tells it from the To date field; both share a placeholder.",
      [remove('label[for="from"]'), setAttr(at('fill_004'), 'id', 'period-start')],
      { effect: 'fails', step: 'fill_004', heal: 'selector' },
      [reselect('fill_004', testid('period-from'))],
    ],
    // The To date field (fill_005: label 'To date', css #to).
    [
      'relabel-to',
      "The 'To date' label changes to 'Until'.",
      [rename('label[for="to"]', 'Until')],
      { effect: 'degrades', step: 'fill_005', heal: 'promotion' },
      [promote('fill_005')],
    ],
    [
      'to-field-removed',
      'The To date field is removed; the period can no longer be closed.',
      [remove(at('fill_005'))],
      { effect: 'fails', step: 'fill_005', heal: 'not_healable' },
    ],
    // The Show transactions button (click_006: role button 'Show transactions', testid show-transactions).
    [
      'rename-show',
      "The 'Show transactions' button is renamed 'View'.",
      [rename(at('click_006'), 'View')],
      { effect: 'degrades', step: 'click_006', heal: 'promotion' },
      [promote('click_006')],
    ],
    [
      'rename-show-drop-testid',
      "The 'Show transactions' button is renamed 'Update' and loses its test id.",
      [rename(at('click_006'), 'Update'), dropAttr(at('click_006'), 'data-testid')],
      { effect: 'fails', step: 'click_006', heal: 'selector' },
      [reselect('click_006', role("button[name='Update']"))],
    ],
    [
      'show-icon-only',
      "The 'Show transactions' button becomes an icon, labelled 'Show transactions for this period' for assistive technology.",
      [
        rename(at('click_006'), '↻'),
        setAttr(at('click_006'), 'aria-label', 'Show transactions for this period'),
      ],
      { effect: 'none', heal: 'none' },
    ],
    [
      'show-icon-only-renamed',
      "The 'Show transactions' button becomes an icon labelled 'Refresh'.",
      [rename(at('click_006'), '↻'), setAttr(at('click_006'), 'aria-label', 'Refresh')],
      { effect: 'degrades', step: 'click_006', heal: 'promotion' },
      [promote('click_006')],
    ],
    [
      'show-in-menu',
      "The 'Show transactions' button moves into a 'More options' dropdown.",
      [menu(at('click_006'), 'More options')],
      { effect: 'fails', step: 'click_006', heal: 'insert_step' },
      [clickFirst('click_006', role("button[name='More options']"), 'Open the More options menu.')],
    ],
    [
      'renamed-show-with-decoy',
      "The 'Show transactions' button is renamed 'Show' and loses its test id, and a 'Show all' button that does the same appears before it.",
      [
        rename(at('click_006'), 'Show'),
        dropAttr(at('click_006'), 'data-testid'),
        decoy(at('click_006'), 'Show all'),
      ],
      { effect: 'fails', step: 'click_006', heal: 'selector', trap: true },
      [reselect('click_006', role("button[name='Show'][exact=true]"))],
    ],
    [
      'show-removed',
      'The Show transactions button is removed; the period can no longer be applied.',
      [remove(at('click_006'))],
      { effect: 'fails', step: 'click_006', heal: 'not_healable' },
    ],
    // The transactions table (extract_007: role table 'Transactions', css table.transactions).
    [
      'table-renamed',
      // Fails rather than degrades, as v1's portal-table-renamed does: a
      // table extract whose role candidate matches nothing reads no headers
      // and fails, without trying the css candidate.
      "The transactions table's accessible name changes to 'Activity'.",
      [setAttr('table.transactions', 'aria-label', 'Activity')],
      { effect: 'fails', step: 'extract_007', heal: 'selector' },
      [reselect('extract_007', role("table[name='Activity']"), css('table.transactions'))],
    ],
    [
      'table-renamed-and-restyled',
      "The transactions table's accessible name and class both change.",
      [
        setAttr('table.transactions', 'aria-label', 'Activity'),
        setAttr('table.transactions', 'class', 'ledger'),
      ],
      { effect: 'fails', step: 'extract_007', heal: 'selector' },
      [reselect('extract_007', role("table[name='Activity']"), css('table.ledger'))],
    ],
    [
      'table-name-longer',
      "The transactions table's accessible name becomes 'Account transactions'.",
      [setAttr('table.transactions', 'aria-label', 'Account transactions')],
      { effect: 'none', heal: 'none' },
    ],
    [
      'rename-amount-header',
      "The 'Amount' column is renamed 'Value'.",
      [rename('table.transactions th:nth-child(3)', 'Value')],
      { effect: 'fails', step: 'extract_007', heal: 'not_healable', gap: 'header_alias' },
    ],
    // The closing balance (extract_008: css #closing-balance).
    [
      'closing-balance-new-id',
      'The closing balance gets a new id; the balance extract reads nothing.',
      [setAttr('#closing-balance', 'id', 'balance')],
      { effect: 'silent', heal: 'none' },
    ],
  ]),
  // Complex changes.
  ...cases('bank', 'complex', [
    [
      'locale-fr',
      // Four promotions, the harness's default heal cap (heal-run.ts).
      'The portal switches to French; test ids and ids stay, and account product names stay in English.',
      [
        rename(at('click_002'), 'Relevés'),
        rename('label[for="from"]', 'Date de début'),
        rename('label[for="to"]', 'Date de fin'),
        rename(at('click_006'), 'Afficher les opérations'),
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
      "A redesign: a terms notice, the account buttons folded into a 'Choose account' dropdown, and 'Show transactions' renamed 'Update' with no test id. Three heals on three steps.",
      [
        banner('We have updated our terms', 'Accept'),
        menu('div[role="group"]', 'Choose account'),
        rename(at('click_006'), 'Update'),
        dropAttr(at('click_006'), 'data-testid'),
      ],
      { effect: 'fails', step: 'click_002', heal: 'insert_step' },
      [
        clickFirst(
          'click_002',
          role("button[name='Accept'][exact=true]"),
          'Accept the terms notice.',
        ),
        clickFirst('click_003', role("button[name='Choose account']"), 'Open the account chooser.'),
        reselect('click_006', role("button[name='Update']")),
      ],
    ],
    [
      'date-labels-reworded',
      "Both date labels are reworded to 'Date from' and 'Date to' and both fields get new ids. Two heals, on two fields whose labels differ by one word; swapping them gives an empty statement.",
      [
        rename('label[for="from"]', 'Date from'),
        rename('label[for="to"]', 'Date to'),
        setAttr(at('fill_004'), 'id', 'date-from'),
        setAttr('label[for="from"]', 'for', 'date-from'),
        setAttr(at('fill_005'), 'id', 'date-to'),
        setAttr('label[for="to"]', 'for', 'date-to'),
      ],
      { effect: 'fails', step: 'fill_004', heal: 'selector' },
      [
        reselect('fill_004', label('Date from'), css('#date-from')),
        reselect('fill_005', label('Date to'), css('#date-to')),
      ],
    ],
    [
      'show-twin',
      'A second Show transactions button, identical to the first and to assistive technology, appears after it. Only its position tells them apart.',
      [decoy(at('click_006'), 'Show transactions', 'after')],
      { effect: 'fails', step: 'click_006', heal: 'selector', trap: true },
      [reselect('click_006', css('form.period button:first-of-type'))],
    ],
    [
      'intermittent-session-banner',
      'A session warning shows on every other visit.',
      [onLoads([1, 3, 5, 7], [banner('Your session will expire in 2 minutes', 'Stay signed in')])],
      { effect: 'fails', step: 'click_002', heal: 'not_healable', gap: 'intermittent' },
    ],
    [
      'ab-test-statements',
      "An A/B test: on every other visit the 'Statements' link is renamed 'Documents' and has no test id.",
      [
        onLoads(
          [1, 3, 5, 7],
          [rename(at('click_002'), 'Documents'), dropAttr(at('click_002'), 'data-testid')],
        ),
      ],
      { effect: 'fails', step: 'click_002', heal: 'not_healable', gap: 'ab_test' },
    ],
    [
      'show-in-iframe',
      'The Show transactions button moves into an embedded frame.',
      [iframe(at('click_006'), 'Transaction filter')],
      { effect: 'fails', step: 'click_006', heal: 'not_healable', gap: 'iframe' },
    ],
    [
      'everyday-in-shadow-dom',
      "The 'Everyday account' button moves into a web component (open shadow DOM).",
      [shadow(at('click_003'))],
      { effect: 'none', heal: 'none' },
    ],
    [
      'slow-show-button',
      // Longer than every candidate's wait together (2 s each, tried in
      // turn), for the reason given on v1's slow-apply-button.
      'The Show transactions button renders 8 seconds late, longer than the action waits through all its selectors.',
      [delay(at('click_006'), 8000)],
      { effect: 'fails', step: 'click_006', heal: 'insert_step' },
      [
        waitFirst(
          'click_006',
          { selectorVisible: '[data-testid="show-transactions"]' },
          'Wait for the Show transactions button to render.',
        ),
      ],
    ],
  ]),
];

/** Every case in set h1. */
export const H1_CASES: SuiteCase[] = [...BANK_CASES];
