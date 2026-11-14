(function () {
  'use strict';
  const U = window.StepwiseUI;
  const { api, h, money, fmtTime, toast, fail, errMsg, table, kvs, field, select, pill, prioPill, openModal } = U;
  const KEY = 'sw_staff_token';
  const store = {
    get() { try { return sessionStorage.getItem(KEY); } catch (e) { return null; } },
    set(v) { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch (e) { /* storage blocked */ } }
  };

  U.views.staff = {
    render(root) {
      let token = store.get();
      let me = null;
      if (token) {
        try { me = api.whoami(token); } catch (e) { token = null; store.set(null); }
      }
      if (!me) return renderLogin(root);
      renderConsole(root, token, me);
    }
  };

  function renderLogin(root) {
    const user = h('input', { autocomplete: 'username', placeholder: 'Username' });
    const pass = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password' });
    const demo = api.demoCredentials();
    const doLogin = () => {
      try {
        const s = api.login(user.value.trim(), pass.value);
        store.set(s.token);
        toast('Signed in as ' + s.user + ' (' + s.role + ').');
        U.route();
      } catch (e) { fail(e); pass.value = ''; }
    };
    pass.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') doLogin(); });
    root.append(
      h('h1', null, 'Staff dispatch & SCADA console'),
      h('p', { class: 'sub' }, 'For dispatchers and supervisors. Access is limited to staff accounts.'),
      h('div', { class: 'split' },
        h('div', { class: 'card' }, h('h2', null, 'Sign in'),
          field('Username', user), field('Password', pass),
          h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn', type: 'button', onclick: doLogin }, 'Sign in'))),
        demo ? h('div', { class: 'card' }, h('h2', null, 'Demo staff accounts'),
          h('p', { class: 'muted' }, 'Only shown while the demo is in test mode.'),
          table(['User', 'Password', 'Role'], demo.staff.map((s) => h('tr', null, h('td', { class: 'mono' }, s.user), h('td', { class: 'mono' }, s.password), h('td', null, s.role))))) : null));
  }

  function renderConsole(root, token, me) {
    const sup = me.role === 'supervisor';
    const panels = [
      ['queue', 'Dispatch queue', () => queuePanel(token, me)],
      ['finance', 'Payments & finance', () => financePanel(token)],
      ['notices', 'Notices', () => noticesPanel(token, sup)],
      ['grid', 'Grid control', () => gridPanel(token, sup)],
      ['brand', 'Brand & settings', () => brandPanel(token, sup)],
      ['data', 'Data & audit', () => dataPanel(token, sup)]
    ].filter(([k]) => sup || ['queue', 'finance'].includes(k));
    const body = h('div');
    const nav = h('div', { class: 'row', role: 'tablist', 'aria-label': 'Console sections', style: 'margin:12px 0' });
    function show(key) {
      const p = panels.find((x) => x[0] === key);
      nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.k === key)));
      body.replaceChildren();
      const built = p[2]();
      body.append(built.el);
      U.setLive(built.live || null);
    }
    nav.append(...panels.map(([k, label]) => h('button', { type: 'button', class: 'btn small ghost', role: 'tab', 'data-k': k, onclick: () => show(k) }, label)));
    const logout = h('button', { type: 'button', class: 'btn small bad auto', onclick: () => {
      try { api.logout(token); } catch (e) { /* session may already be gone */ }
      store.set(null); toast('Signed out.'); U.route();
    } }, 'Sign out');
    root.append(
      h('div', { class: 'card', style: 'display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap' },
        h('div', null, h('strong', null, me.user), ' · ', pill(me.role, 'ok'), h('div', { class: 'muted' }, 'Session ends automatically after 30 minutes of inactivity.')), logout),
      h('h1', { style: 'margin-top:14px' }, 'Staff console'), nav, body);
    show(panels[0][0]);
  }

  // The viewer sandbox returns false from confirm(), so confirmations are built into the page.
  function confirmAction(question, okLabel, onOk) {
    const close = U.openModal(h('div', { class: 'card', role: 'dialog', 'aria-modal': 'true' },
      h('p', null, question),
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', { class: 'btn bad', type: 'button', onclick: () => { close(); onOk(); } }, okLabel),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => close() }, 'Keep'))));
  }

  // ---------- queue ----------
  function queuePanel(token, me) {
    const kind = select([['all', 'Faults and tip-offs'], ['FAULT', 'Faults only'], ['TIP', 'Tip-offs only']], 'all');
    const closed = h('input', { type: 'checkbox', id: 'show-closed', style: 'width:auto' });
    const box = h('div');
    const el = h('div', null,
      h('div', { class: 'row', style: 'margin-bottom:10px' }, field('Show', kind), h('label', { class: 'auto', for: 'show-closed', style: 'margin-top:22px' }, closed, ' Show closed')),
      box);
    function draw() {
      let rows;
      try { rows = api.staffTickets(token, { kind: kind.value === 'all' ? undefined : kind.value, status: closed.checked ? 'all' : 'open' }); }
      catch (e) { box.replaceChildren(); fail(e); return; }
      box.replaceChildren(table(['Ticket', 'Type', 'Area', 'Priority', 'Stage', 'Age', 'Crew', 'Actions'],
        rows.map((t) => h('tr', null,
          h('td', { class: 'mono' }, t.ticket_id, t.overdue ? h('div', { class: 'pill bad' }, 'Overdue') : null),
          h('td', null, t.category_label),
          h('td', null, t.suburb_name, t.pole_tag ? h('div', { class: 'mono muted' }, t.pole_tag) : null, t.address_text ? h('div', { class: 'muted' }, t.address_text) : null),
          h('td', null, t.priority ? prioPill(t.priority) : pill('Private', '')),
          h('td', null, pill(t.stage, t.terminal ? '' : 'ok')),
          h('td', null, t.age_min + ' min'),
          h('td', null, t.assigned_crew || '—'),
          h('td', null, h('div', { class: 'row' },
            t.next_stage ? h('button', { class: 'btn small', type: 'button', onclick: () => advance(t) }, 'To ' + t.next_stage) : null,
            t.terminal ? null : h('button', { class: 'btn small bad', type: 'button', onclick: () => cancel(t) }, 'Cancel'),
            h('button', { class: 'btn small ghost', type: 'button', onclick: () => history(t) }, 'History'))))
        )));
    }
    function advance(t) {
      try { api.advanceTicket(token, t.ticket_id, ''); toast(t.ticket_id + ' moved on.'); }
      catch (e) { fail(e); }
      draw();
    }
    function cancel(t) {
      const reason = h('textarea', { maxlength: '200', placeholder: 'Why is this ticket being cancelled?', 'aria-label': 'Cancellation reason' });
      const close = U.openModal(h('div', { class: 'card', role: 'dialog', 'aria-modal': 'true' },
        h('h2', null, 'Cancel ' + t.ticket_id + '?'),
        field('Reason (required)', reason),
        h('div', { class: 'row', style: 'margin-top:10px' },
          h('button', { class: 'btn bad', type: 'button', onclick: () => {
            try { api.cancelTicket(token, t.ticket_id, reason.value); close(); toast(t.ticket_id + ' cancelled.'); draw(); }
            catch (e) { fail(e); }
          } }, 'Cancel ticket'),
          h('button', { class: 'btn ghost', type: 'button', onclick: () => close() }, 'Back'))));
    }
    function history(t) {
      const cur = api.staffTickets(token, { status: 'all' }).find((x) => x.ticket_id === t.ticket_id) || t;
      openModal(h('div', { class: 'card', role: 'dialog', 'aria-modal': 'true' },
        h('h2', null, cur.ticket_id + ' history'),
        h('p', { class: 'muted' }, cur.category_label + ' · ' + cur.suburb_name + (cur.grid_name ? ' · ' + cur.grid_name : '')),
        h('ul', { class: 'timeline' }, cur.events.map((e) => h('li', null, h('strong', null, e.to || e.from || 'Event'), ' · ', h('span', { class: 'muted' }, fmtTime(e.at) + ' · ' + e.actor), e.note ? h('div', { class: 'muted' }, e.note) : null))),
        cur.reports && cur.reports.length > 1 ? h('p', { class: 'muted' }, cur.reports.length + ' reports attached.') : null,
        h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn', type: 'button', onclick: () => document.querySelector('#layer').replaceChildren() }, 'Close'))));
    }
    kind.addEventListener('change', draw); closed.addEventListener('change', draw);
    draw();
    return { el, live: draw };
  }

  // ---------- finance ----------
  function financePanel(token) {
    const box = h('div');
    function draw() {
      let r, pays;
      try { r = api.financeReport(token); pays = api.listPayments(token); }
      catch (e) { box.replaceChildren(); return fail(e); }
      box.replaceChildren(
        h('div', { class: 'grid' },
          h('div', { class: 'card stat' }, h('b', null, money(r.vend.amount_toea)), h('span', null, 'Token sales (' + r.vend.count + ')')),
          h('div', { class: 'card stat' }, h('b', null, money(r.vend.gst_toea)), h('span', null, 'GST included in sales')),
          h('div', { class: 'card stat' }, h('b', null, money(r.postpaid.amount_toea)), h('span', null, 'Postpaid receipts (' + r.postpaid.count + ')')),
          h('div', { class: 'card stat' }, h('b', null, String(r.pending.count)), h('span', null, 'Pending payments · ' + r.failed.count + ' failed · ' + r.expired.count + ' expired'))),
        r.anomalies.length
          ? h('div', { class: 'notice bad', style: 'margin-top:14px' }, h('strong', null, 'Reconciliation: ' + r.anomalies.length + ' issue(s). '), h('ul', null, r.anomalies.map((a) => h('li', null, a))))
          : h('div', { class: 'notice ok', style: 'margin-top:14px' }, 'Reconciliation clean: token ledger, GST split, meter credits and invoice allocations all agree.'),
        h('h2', { style: 'margin-top:16px' }, 'Recent payments'),
        table(['Time', 'Type', 'Reference', 'Amount', 'Fee', 'Channel', 'Status', 'Note'],
          pays.map((p) => h('tr', null, h('td', null, fmtTime(p.created_at)), h('td', null, p.kind), h('td', { class: 'mono' }, p.ref), h('td', null, money(p.amount_toea)), h('td', null, money(p.fee_toea)), h('td', null, p.channel_label), h('td', null, pill(p.status, p.status === 'SETTLED' ? 'ok' : p.status === 'PENDING' ? 'warn' : 'bad')), h('td', { class: 'muted' }, p.failure_reason || (p.tx_ref ? p.tx_ref : ''))))));
    }
    draw();
    return { el: box, live: draw };
  }

  // ---------- notices ----------
  function noticesPanel(token, sup) {
    if (!sup) return { el: h('p', { class: 'muted' }, 'Supervisors manage notices.') };
    const box = h('div');
    const cat = select([['Planned Outages', 'Planned outages'], ['Safety & Compliance', 'Safety & compliance'], ['Corporate News', 'Corporate news']], 'Planned Outages');
    const region = h('input', { placeholder: 'Region, e.g. Capital Grid' });
    const title = h('input', { maxlength: '120', placeholder: 'Title' });
    const summary = h('input', { maxlength: '200', placeholder: 'One-line summary' });
    const body = h('textarea', { maxlength: '1200', placeholder: 'Full notice text' });
    function draw() {
      let list;
      try { list = api.listNotices(); } catch (e) { return box.replaceChildren(); }
      box.replaceChildren(
        h('h2', null, 'Post a notice'),
        h('div', { class: 'split' }, field('Category', cat), field('Region', region)),
        field('Title', title), field('Summary', summary), field('Body', body),
        h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn', type: 'button', onclick: post }, 'Publish notice')),
        h('h2', { style: 'margin-top:18px' }, 'Current notices'),
        table(['Posted', 'Category', 'Title', ''], list.map((n) => h('tr', null, h('td', null, fmtTime(n.posted_at)), h('td', null, n.category), h('td', null, n.title),
          h('td', null, h('button', { class: 'btn small bad', type: 'button', onclick: () => remove(n) }, 'Delete'))))));
    }
    function post() {
      try {
        api.postNotice(token, { category: cat.value, region: region.value, title: title.value, summary: summary.value, body: body.value });
        toast('Notice published to the public news page.');
        title.value = ''; summary.value = ''; body.value = ''; draw();
      } catch (e) { fail(e); }
    }
    function remove(n) {
      confirmAction('Delete "' + n.title + '"?', 'Delete notice', () => {
        try { api.deleteNotice(token, n.id); toast('Notice deleted.'); draw(); } catch (e) { fail(e); }
      });
    }
    draw();
    return { el: box, live: draw };
  }

  // ---------- grid control ----------
  function gridPanel(token, sup) {
    const box = h('div');
    function draw() {
      const grids = api.getGrid();
      box.replaceChildren(
        h('p', { class: 'muted' }, 'Overrides show on the public Grid page straight away. Clearing an override returns the grid to automatic status from open hazards.'),
        table(['Grid', 'Status', 'Source', 'Load', 'Set status'], grids.map((g) => {
          const sel = select([['', 'Automatic'], ['Scheduled Inspection', 'Scheduled inspection'], ['Feeder Load Shedding', 'Feeder load shedding']], g.source.startsWith('Control room') ? (g.status === 'Scheduled Inspection' ? 'Scheduled Inspection' : 'Feeder Load Shedding') : '');
          const apply = h('button', { class: 'btn small', type: 'button', onclick: () => {
            try { api.setGridOverride(token, g.key, sel.value || null); toast(g.name + ' updated.'); draw(); } catch (e) { fail(e); }
          } }, 'Apply');
          return h('tr', null, h('td', null, g.name), h('td', null, pill(g.status, /Normal/.test(g.status) ? 'ok' : 'warn')), h('td', { class: 'muted' }, g.source), h('td', null, g.load_mw + ' / ' + g.capacity_mw + ' MW'), h('td', null, sup ? h('div', { class: 'row' }, sel, apply) : '—'));
        })));
    }
    draw();
    return { el: box, live: draw };
  }

  // ---------- brand & settings ----------
  function brandPanel(token, sup) {
    const b = api.getBrand();
    const name = h('input', { value: b.name, maxlength: '40' });
    const tag = h('input', { value: b.tagline, maxlength: '60' });
    const hot = h('input', { value: b.hotline, maxlength: '40' });
    const color = h('input', { type: 'color', value: b.color, 'aria-label': 'Brand colour' });
    const cfg = api.getConfig();
    const creds = api.demoCredentials();
    const showCreds = h('input', { type: 'checkbox', style: 'width:auto', id: 'showc', checked: creds !== null });
    return { el: h('div', null,
      h('h2', null, 'Brand'),
      h('p', { class: 'muted' }, 'Change the name, tagline, hotline and colour shown across the portal. Use a placeholder name for client demos.'),
      h('div', { class: 'split' }, field('Utility name', name), field('Tagline', tag)),
      h('div', { class: 'split' }, field('Hotline (demo)', hot), field('Brand colour', color)),
      h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn', type: 'button', onclick: () => {
        try { api.updateBrand(token, { name: name.value, tagline: tag.value, hotline: hot.value, color: color.value }); U.applyBrand(); toast('Brand saved.'); }
        catch (e) { fail(e); }
      } }, 'Save brand')),
      h('h2', { style: 'margin-top:20px' }, 'Demo settings'),
      h('label', { style: 'display:flex;gap:8px;align-items:center' }, showCreds, ' Show demo test accounts on the public site'),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn ghost small', type: 'button', onclick: () => {
        try { api.setDemoCredentialsVisible(token, showCreds.checked); toast('Saved.'); } catch (e) { fail(e); }
      } }, 'Save setting')),
      h('p', { class: 'muted', style: 'margin-top:12px' }, 'Tariffs: ' + Object.keys(cfg.tariffs).map((k) => cfg.tariffs[k].label + ' K' + (cfg.tariffs[k].rate_toea / 100).toFixed(2) + '/kWh').join('; ') + '. GST ' + (cfg.gst_bp / 100) + '% included in each sale. All values are sample values.'))
    };
  }

  // ---------- data & audit (supervisor) ----------
  function dataPanel(token, sup) {
    if (!sup) return { el: h('p', { class: 'muted' }, 'Supervisors only.') };
    const box = h('div');
    const tableSel = select([['meters', 'Meters'], ['vend_transactions', 'Token ledger'], ['payments', 'Payments'], ['tickets', 'Tickets'], ['ticket_events', 'Ticket events'], ['grid', 'Grid state'], ['notices', 'Notices']], 'meters');
    const pre = h('pre', { class: 'mono', style: 'max-height:340px;overflow:auto;background:var(--bg);padding:10px;border-radius:8px;font-size:12px;white-space:pre-wrap' });
    function inspect() {
      try { pre.textContent = JSON.stringify(api.inspectTable(token, tableSel.value), null, 2); }
      catch (e) { pre.textContent = errMsg(e); }
    }
    function audit() {
      try {
        const rows = api.auditLog(token);
        box.querySelector('#audit') && box.querySelector('#audit').replaceChildren(table(['When', 'Actor', 'Action', 'Entity', 'Detail'], rows.slice(0, 100).map((a) => h('tr', null, h('td', null, fmtTime(a.at)), h('td', null, a.actor), h('td', { class: 'mono' }, a.action), h('td', { class: 'mono' }, a.entity), h('td', null, a.detail)))));
      } catch (e) { fail(e); }
    }
    // Downloads are blocked inside artifact viewers, so the export is shown as selectable text with a copy button.
    const exportBtn = h('button', { class: 'btn ghost small', type: 'button', onclick: () => {
      let text;
      try { text = api.exportDb(token); } catch (e) { return fail(e); }
      const copy = h('button', { class: 'btn small', type: 'button', onclick: () => {
        const p = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard'));
        p.then(() => toast('Copied to clipboard.'), () => toast('Copy is blocked here. Select the text and copy it.'));
      } }, 'Copy JSON');
      const close = U.openModal(h('div', { class: 'card', role: 'dialog', 'aria-modal': 'true' },
        h('h2', null, 'Database export (JSON)'),
        h('p', { class: 'muted' }, 'Password and PIN hashes are removed. Select the text or use Copy.'),
        h('pre', { class: 'mono', style: 'max-height:50vh;overflow:auto;white-space:pre-wrap;font-size:11px;background:var(--bg);padding:10px;border-radius:8px' }, text),
        h('div', { class: 'row', style: 'margin-top:10px' }, copy, h('button', { class: 'btn ghost', type: 'button', onclick: () => close() }, 'Close'))));
    } }, 'Export database (JSON)');
    const resetBtn = h('button', { class: 'btn bad small', type: 'button', onclick: () => {
      confirmAction('Reset all demo data to the starting state? This clears tickets and payments.', 'Reset demo', () => {
        try { api.resetDemo(token); toast('Demo data reset.'); } catch (e) { fail(e); }
      });
    } }, 'Reset demo data');
    const el = h('div', null,
      h('h2', null, 'Simulated database'),
      h('p', { class: 'muted' }, 'This is the local store behind the portal. PIN and password hashes are hidden. Writes go through the same rules as the public screens.'),
      h('div', { class: 'row' }, field('Table', tableSel), h('button', { class: 'btn ghost auto', type: 'button', onclick: inspect }, 'Inspect')),
      pre,
      h('h2', { style: 'margin-top:18px' }, 'Audit log'),
      h('div', { id: 'audit' }),
      h('h2', { style: 'margin-top:18px' }, 'Maintenance'),
      h('div', { class: 'row' }, exportBtn, resetBtn));
    box.append(el);
    inspect(); audit();
    return { el: box, live: audit };
  }
})();
