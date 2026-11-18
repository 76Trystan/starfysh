// Drift operators, run inside the page. Loaded as a string by drift.ts and
// injected with page.addInitScript, followed by a call to
// __sfyshApplyDrifts(drifts). Plain JavaScript on purpose: a function
// passed to addInitScript from TypeScript is serialised with toString(),
// and the TypeScript loader can add helper calls that do not exist here.
//
// Each operator is a small, deterministic DOM edit. Operators that move or
// rebuild an element keep its attributes, including data-action (so the
// page still behaves) and data-sfysh-truth (so the drift fixture can still
// tell which element was meant). Anything an operator adds for its own
// purposes is marked data-sfysh-truth="drift:<what>" or "decoy".
//
// A selector that matches nothing is a broken case, not a drift: it is
// recorded in window.__sfyshDriftErrors and the harness refuses the case.

/* eslint-disable */
window.__sfyshDriftErrors = [];

function __sfyshApplyDrifts(drifts) {
  const apply = () => {
    for (const drift of drifts) {
      try {
        __sfyshApplyOne(drift);
      } catch (error) {
        window.__sfyshDriftErrors.push(String((error && error.message) || error));
      }
    }
    window.__sfyshDriftsApplied = true;
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply, { once: true });
  } else {
    apply();
  }
}

function __sfyshOne(selector) {
  const el = document.querySelector(selector);
  if (!el) throw new Error('drift selector matches nothing: ' + selector);
  return el;
}

function __sfyshApplyOne(drift) {
  switch (drift.op) {
    case 'rename_text': {
      // Visible text, and so the accessible name of a link, button,
      // heading or label.
      __sfyshOne(drift.selector).textContent = drift.text;
      return;
    }
    case 'set_attribute': {
      __sfyshOne(drift.selector).setAttribute(drift.name, drift.value);
      return;
    }
    case 'remove_attribute': {
      __sfyshOne(drift.selector).removeAttribute(drift.name);
      return;
    }
    case 'retag': {
      // A link becomes a button, a button a div, and so on. Attributes and
      // children move over; the role changes with the tag.
      const old = __sfyshOne(drift.selector);
      const next = document.createElement(drift.tag);
      for (const attr of Array.from(old.attributes)) next.setAttribute(attr.name, attr.value);
      while (old.firstChild) next.appendChild(old.firstChild);
      old.replaceWith(next);
      return;
    }
    case 'reorder_columns': {
      // Every row of the table, header included, gets its cells in the
      // given order of old positions.
      const table = __sfyshOne(drift.table);
      for (const row of Array.from(table.querySelectorAll('tr'))) {
        const cells = Array.from(row.children);
        for (const index of drift.order) {
          if (cells[index]) row.appendChild(cells[index]);
        }
      }
      return;
    }
    case 'wrap_in_menu': {
      // The element moves into a dropdown that is closed until its button
      // is pressed: the flow now needs one more click.
      const el = __sfyshOne(drift.selector);
      const menu = document.createElement('div');
      menu.className = 'menu';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.textContent = drift.menuLabel;
      toggle.setAttribute('data-action', 'toggle-menu');
      toggle.setAttribute('data-sfysh-truth', 'drift:menu');
      const list = document.createElement('div');
      list.setAttribute('data-role', 'menu-list');
      list.hidden = true;
      el.replaceWith(menu);
      list.appendChild(el);
      menu.appendChild(toggle);
      menu.appendChild(list);
      return;
    }
    case 'add_overlay': {
      // A full-page banner that covers everything until dismissed.
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', drift.text);
      const box = document.createElement('div');
      const text = document.createElement('p');
      text.textContent = drift.text;
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.textContent = drift.dismissLabel;
      dismiss.setAttribute('data-action', 'dismiss');
      dismiss.setAttribute('data-sfysh-truth', 'drift:dismiss');
      box.appendChild(text);
      box.appendChild(dismiss);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      return;
    }
    case 'add_decoy': {
      // A copy of an element with new text that behaves the same way. A
      // heal that picks it produces the same outputs while acting on the
      // wrong element: the false heal that output checks cannot see.
      const el = __sfyshOne(drift.selector);
      const decoy = el.cloneNode(true);
      decoy.textContent = drift.text;
      decoy.setAttribute('data-sfysh-truth', 'decoy');
      decoy.removeAttribute('id');
      if (drift.position === 'before') el.before(decoy);
      else el.after(decoy);
      return;
    }
    case 'remove': {
      __sfyshOne(drift.selector).remove();
      return;
    }
    default:
      throw new Error('unknown drift op: ' + drift.op);
  }
}
