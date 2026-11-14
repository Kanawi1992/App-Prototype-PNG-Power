(function () {
  'use strict';
  const E = window.StepwiseEngine, A = window.StepwiseAssistant;
  const TZ = 'Pacific/Port_Moresby';
  let api;
  try {
    api = E.create({ storage: window.localStorage });
  } catch (e) {
    api = E.create({ storage: null });
  }
  const bot = A.createAssistant(api);

  // ---------- helpers (DOM is built with text nodes only, never innerHTML) ----------
  const $ = (s) => document.querySelector(s);
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of Array.prototype.slice.call(arguments, 2).flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const money = (t) => 'K' + (t / 100).toFixed(2);
  const fmtTime = (iso) => iso ? new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : '';
  const newKey = () => 'web' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  function parseKina(v) {
    const s = String(v || '').trim();
    if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error('Enter an amount in kina, for example 20 or 20.50.');
    return Math.round(parseFloat(s) * 100);
  }
  const toastTimer = { id: null };
  function toast(msg) {
    const layer = $('#layer');
    const old = layer.querySelector('.toast'); if (old) old.remove();
    const t = h('div', { class: 'toast', role: 'status' }, msg);
    layer.append(t);
    clearTimeout(toastTimer.id);
    toastTimer.id = setTimeout(() => t.remove(), 4200);
  }
  const errMsg = (e) => (e && e.message) ? e.message : 'Something went wrong. Please try again.';
  function fail(e) { toast(errMsg(e)); }
  function ledNode(led) {
    return h('span', null, h('span', { class: 'led ' + led.state, 'aria-hidden': 'true' }), led.label);
  }
  function pill(text, cls) { return h('span', { class: 'pill ' + (cls || '') }, text); }
  function prioPill(p) { return p ? pill(p, p.toLowerCase()) : null; }
  function stageCls(t) { return t.terminal ? 'pill' : (t.priority === 'P1' ? 'pill p1' : 'pill'); }
  function openModal(card) {
    const layer = $('#layer');
    const back = h('div', { class: 'modal', onclick: (ev) => { if (ev.target === back) layer.replaceChildren(); } }, card);
    layer.replaceChildren(back);
    const first = card.querySelector('button, input, select, textarea');
    if (first) first.focus();
    return () => layer.replaceChildren();
  }
  function table(headers, rows) {
    return h('div', { class: 'scroll' }, h('table', null,
      h('thead', null, h('tr', null, headers.map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: headers.length, class: 'muted' }, 'Nothing to show yet.')))));
  }
  function kvs(pairs) {
    return h('div', { class: 'kv' }, pairs.map(([k, v]) => [h('div', null, k), h('div', null, v)]));
  }
  function field(label, control) { return h('div', null, h('label', null, label), control); }
  function select(opts, value) {
    return h('select', null, opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  }
  const tokenNode = (t) => h('div', { class: 'token', 'aria-label': 'Token ' + t.split('').join(' ') }, t);
  function breakdown(q) {
    return kvs([
      ['Amount', money(q.amount_toea)],
      ['Includes GST (10%)', money(q.gst_toea)],
      ['Energy value', money(q.energy_toea)],
      ['Channel fee', q.fee_toea ? money(q.fee_toea) : 'None'],
      ['You pay', money(q.total_toea)],
      ['Units (demo rate ' + money(q.rate_toea) + '/kWh)', q.kwh + ' kWh']
    ]);
  }
  function stageBar(t) {
    const idx = t.stage_index;
    return h('ol', { class: 'steps', style: 'list-style:none;padding:0;margin:8px 0' }, t.stages.map((s, i) =>
      h('li', { style: 'padding-left:34px;position:relative;margin-bottom:6px;' + (i <= idx ? 'font-weight:700' : 'color:var(--muted)') },
        h('span', { style: 'position:absolute;left:0;top:0;width:24px;height:24px;border-radius:50%;text-align:center;line-height:24px;font-size:13px;background:' + (i <= idx ? 'var(--brand);color:#fff' : 'var(--line)') }, i < idx ? '✓' : String(i + 1)),
        s)));
  }

  // ---------- state ----------
  const auth = { meter: {}, account: null }; // unlock tokens for this browser tab only
  let current = null; // { name, live }
  const views = {};
  const NAV = [
    ['dashboard', 'Home'], ['easipay', 'EasiPay'], ['tracker', 'Faults & Tracker'], ['grid', 'Grid'], ['news', 'News'],
    ['offices', 'Offices'], ['fraud', 'Report Tampering'], ['safety', 'Safety'], ['chat', 'Assistant'], ['staff', 'Staff']
  ];

  function go(name) {
    if (!views[name]) name = 'dashboard';
    if (location.hash !== '#' + name) location.hash = name;
    else route();
  }
  function route() {
    const name = (location.hash || '#dashboard').slice(1);
    const key = views[name] ? name : 'dashboard';
    current = { name: key, live: null };
    document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-current', b.dataset.view === key ? 'page' : 'false'));
    const root = $('#view');
    root.replaceChildren();
    try {
      views[key].render(root);
    } catch (e) {
      root.replaceChildren(h('div', { class: 'notice bad' }, 'This screen could not load: ' + errMsg(e)));
      console.error(e);
    }
    $('#tabs').classList.remove('open');
    $('#menuBtn').setAttribute('aria-expanded', 'false');
    window.scrollTo(0, 0);
  }
  function buildNav() {
    const tabs = $('#tabs');
    tabs.replaceChildren(...NAV.map(([k, label]) => h('button', { type: 'button', 'data-view': k, onclick: () => go(k) }, label)));
  }
  function applyBrand() {
    const b = api.getBrand();
    $('#brandName').textContent = b.name;
    $('#brandTag').textContent = b.tagline;
    document.title = b.name + ' - ' + b.tagline;
    document.documentElement.style.setProperty('--brand', b.color);
  }
  function updateStorageNote() {
    const hl = api.health();
    $('#storageNote').textContent = hl.persistent
      ? 'Saved locally in this browser (revision ' + hl.rev + ').'
      : 'Browser storage is blocked, so data lasts only until you reload.';
  }
  api.on(() => {
    updateStorageNote();
    applyBrand();
    if (current && current.live) { try { current.live(); } catch (e) { console.error(e); } }
  });
  window.addEventListener('storage', (ev) => { if (ev.key === E.DB_KEY) api.reload(); });
  window.addEventListener('hashchange', route);
  $('#menuBtn').addEventListener('click', () => {
    const open = $('#tabs').classList.toggle('open');
    $('#menuBtn').setAttribute('aria-expanded', String(open));
  });

  // ---------- DASHBOARD ----------
  views.dashboard = {
    render(root) {
      const b = api.getBrand();
      const st = api.getStats();
      const notices = api.listNotices().slice(0, 2);
      const creds = api.demoCredentials();
      root.append(
        h('section', { class: 'hero' },
          h('h1', { style: 'color:#fff' }, 'Welcome to ' + b.name),
          h('p', null, 'Buy tokens, report faults, check the grid and get answers from the assistant. Every transaction runs through the simulated back end in this browser.'),
          h('p', null, 'Hotline (demo): ' + b.hotline)),
        h('div', { class: 'grid stats', 'aria-label': 'Quick stats' },
          h('div', { class: 'card stat' }, h('b', null, String(st.tokens)), h('span', null, 'Tokens issued')),
          h('div', { class: 'card stat' }, h('b', null, st.kwh.toLocaleString('en-GB') + ' kWh'), h('span', null, 'Energy vended')),
          h('div', { class: 'card stat' }, h('b', null, String(st.open_faults)), h('span', null, 'Open fault tickets')),
          h('div', { class: 'card stat' }, h('b', { style: st.open_p1 ? 'color:var(--bad)' : '' }, String(st.open_p1)), h('span', null, 'Open P1 hazards'))
        ),
        h('h2', { style: 'margin-top:20px' }, 'What do you need?'),
        h('div', { class: 'grid' },
          actionCard('Buy a token', 'Pay for electricity and get a token for your meter.', 'easipay'),
          actionCard('Report a fault', 'Blackouts, low wires and poles. Get a ticket number.', 'tracker'),
          actionCard('Report tampering', 'Confidentially report an illegal connection.', 'fraud'),
          actionCard('Check the grid', 'Live status and load for each regional grid.', 'grid'),
          actionCard('Ask the assistant', 'Plain-language help, tickets and grid status.', 'chat')
        ),
        h('h2', { style: 'margin-top:20px' }, 'Latest notices'),
        h('div', { class: 'grid' }, notices.map((n) => h('div', { class: 'card' },
          h('div', { class: 'muted' }, n.category + ' · ' + fmtTime(n.posted_at)),
          h('strong', null, n.title),
          h('p', { class: 'muted' }, n.summary),
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => go('news') }, 'All notices')))),
        creds ? h('div', { class: 'card', style: 'margin-top:20px' },
          h('h2', null, 'Demo test accounts'),
          h('p', { class: 'muted' }, 'Use these to try the flows. They are fake and only work in this demo.'),
          table(['Meter', 'Label', 'PIN'], creds.meters.map((m) => h('tr', null, h('td', { class: 'mono' }, m.meter_number), h('td', null, m.label), h('td', { class: 'mono' }, m.pin)))),
          h('p', { class: 'muted' }, 'Postpaid account ' + creds.account.account + ', PIN ' + creds.account.pin + '.'),
          h('p', { class: 'muted' }, 'Staff login: dispatcher / dispatch123 or supervisor / super123.')) : null
      );
      function actionCard(title, text, view) {
        return h('div', { class: 'card' }, h('strong', null, title), h('p', { class: 'muted' }, text),
          h('button', { class: 'btn small', type: 'button', onclick: () => go(view) }, 'Open'));
      }
    }
  };

  // ---------- EASIPAY ----------
  views.easipay = {
    render(root) {
      const cfg = api.getConfig();
      const chOpts = cfg.channels.map((c) => [c.id, c.label]);
      const lastMeter = { v: '' };

      // -- buy a token --
      const meterIn = h('input', { id: 'ep-meter', inputmode: 'numeric', maxlength: '11', placeholder: '11-digit meter number', autocomplete: 'off' });
      const meterInfo = h('div', { 'aria-live': 'polite' });
      const amountIn = h('input', { id: 'ep-amount', inputmode: 'decimal', placeholder: 'e.g. 20.00' });
      const chanIn = select(chOpts, 'wallet'); chanIn.id = 'ep-channel';
      const quoteBox = h('div', { class: 'muted', 'aria-live': 'polite' });
      const payBtn = h('button', { class: 'btn', type: 'button', disabled: true }, 'Pay');
      const result = h('div', { 'aria-live': 'polite' });
      let meter = null;

      function refreshQuote() {
        if (!meter) { quoteBox.replaceChildren(); payBtn.disabled = true; payBtn.textContent = 'Pay'; return; }
        let amt;
        try { amt = parseKina(amountIn.value); } catch (e) { quoteBox.textContent = ''; payBtn.disabled = true; payBtn.textContent = 'Pay'; return; }
        try {
          const q = api.quote({ meter_number: meter.meter_number, amount_toea: amt, channel: chanIn.value });
          quoteBox.replaceChildren(breakdown(q));
          payBtn.disabled = false; payBtn.textContent = 'Pay ' + money(q.total_toea);
        } catch (e) { quoteBox.textContent = errMsg(e); payBtn.disabled = true; payBtn.textContent = 'Pay'; }
      }
      amountIn.addEventListener('input', refreshQuote);
      chanIn.addEventListener('change', refreshQuote);

      function checkMeter() {
        try {
          meter = api.lookupMeter(meterIn.value.trim());
          lastMeter.v = meter.meter_number;
          meterInfo.replaceChildren(kvs([
            ['Customer', meter.holder_masked],
            ['Tariff', meter.tariff_label + ' · ' + money(meter.rate_toea) + '/kWh'],
            ['Feeder', meter.feeder],
            ['Credit light', ledNode(meter.led)]
          ]));
          refreshQuote();
        } catch (e) { meter = null; meterInfo.replaceChildren(); refreshQuote(); fail(e); }
      }
      function pay() {
        if (!meter) return;
        let amt;
        try { amt = parseKina(amountIn.value); } catch (e) { return fail(e); }
        payBtn.disabled = true;
        let p;
        try {
          p = api.createPayment({ kind: 'VEND', meter_number: meter.meter_number, amount_toea: amt, channel: chanIn.value, idempotency_key: newKey() });
        } catch (e) { fail(e); refreshQuote(); return; }
        openGateway(p, (res) => showVendResult(res, p), () => refreshQuote());
      }
      function showVendResult(res, p) {
        result.replaceChildren();
        const pay = res.payment;
        if (res.tx) {
          result.append(h('div', { class: 'card', style: 'margin-top:12px' },
            h('span', { class: 'pill ok' }, 'Token issued'),
            h('h2', { style: 'margin-top:8px' }, 'Your token'),
            tokenNode(res.tx.token),
            h('p', { class: 'muted' }, 'Enter this on the meter keypad. Transaction ' + res.tx.tx_ref + ', ' + res.tx.kwh + ' kWh added.'),
            kvs([['Meter credit light', ledNode(res.meter_led)], ['Paid', money(pay.total_toea)], ['Time', fmtTime(res.tx.created_at)]])
          ));
          amountIn.value = ''; refreshQuote();
          return;
        }
        if (pay.status === 'PENDING') {
          result.append(h('div', { class: 'notice warn' },
            h('strong', null, 'Payment not confirmed yet. '), 'No token has been issued. You are not charged twice if you retry with the same payment.',
            h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn small', type: 'button', onclick: () => checkStatus(pay.id) }, 'Check payment status'))));
          return;
        }
        result.append(h('div', { class: 'notice bad' }, h('strong', null, 'Payment ' + pay.status.toLowerCase() + '. '), pay.failure_reason || 'No token was issued.'));
      }
      function checkStatus(id) {
        try {
          const res = api.reconcilePayment(id);
          showVendResult(res, null);
        } catch (e) { result.replaceChildren(h('div', { class: 'notice bad' }, errMsg(e))); }
      }

      payBtn.addEventListener('click', pay);
      meterIn.addEventListener('change', checkMeter);
      meterIn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); checkMeter(); } });

      root.append(
        h('h1', null, 'EasiPay: buy a token'),
        h('p', { class: 'sub' }, 'Pay for electricity with your meter number. Tokens are issued after the payment is confirmed.'),
        h('div', { class: 'split' },
          h('div', { class: 'card' },
            h('h2', null, '1. Your meter'),
            field('Meter number', meterIn),
            h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn ghost auto', type: 'button', onclick: checkMeter }, 'Check meter')),
            meterInfo),
          h('div', { class: 'card' },
            h('h2', null, '2. Amount and payment'),
            field('Amount (kina)', amountIn),
            field('Payment channel', chanIn),
            h('p', { class: 'muted' }, 'Limits and fees: ' + cfg.channels.map((c) => c.label + ' K' + (c.min_toea / 100) + '–K' + (c.max_toea / 100)).join('; ') + '.'),
            quoteBox,
            h('div', { class: 'row', style: 'margin-top:10px' }, payBtn))
        ),
        result,
        h('div', { class: 'split', style: 'margin-top:18px' }, tokenHistorySection(), postpaidSection())
      );

      function tokenHistorySection() {
        const num = h('input', { placeholder: 'Meter number', inputmode: 'numeric', maxlength: '11' });
        const pin = h('input', { type: 'password', placeholder: 'Meter PIN', autocomplete: 'off', inputmode: 'numeric' });
        const out = h('div');
        const load = () => {
          const token = auth.meter[num.value.trim()];
          try {
            const r = api.listVendHistory({ meter_number: num.value.trim(), auth_token: token });
            out.replaceChildren(
              h('h3', { style: 'font-size:15px' }, 'Recent tokens'),
              table(['Time', 'Token', 'kWh', 'Paid'], r.transactions.map((t) => h('tr', null, h('td', null, fmtTime(t.created_at)), h('td', { class: 'mono' }, t.token), h('td', null, String(t.kwh)), h('td', null, money(t.amount_toea))))),
              r.payments.length ? h('p', { class: 'muted' }, r.payments.length + ' payment(s) not yet confirmed. Check status in the payment panel above.') : null);
          } catch (e) { out.replaceChildren(); fail(e); }
        };
        const unlock = () => {
          try {
            const s = api.verifyMeter(num.value.trim(), pin.value);
            auth.meter[num.value.trim()] = s.auth_token;
            pin.value = '';
            toast('Meter unlocked for 15 minutes.');
            load();
          } catch (e) { fail(e); }
        };
        return h('div', { class: 'card' },
          h('h2', null, 'Token history'),
          h('p', { class: 'muted' }, 'Enter the meter PIN to see past tokens. Tokens are never shown without a PIN.'),
          field('Meter number', num), field('Meter PIN', pin),
          h('div', { class: 'row', style: 'margin-top:10px' },
            h('button', { class: 'btn ghost', type: 'button', onclick: unlock }, 'Unlock and view'),
            h('button', { class: 'btn ghost', type: 'button', onclick: load }, 'Refresh')),
          out);
      }

      function postpaidSection() {
        const acc = h('input', { placeholder: 'Account number' });
        const pin = h('input', { type: 'password', placeholder: 'Account PIN', autocomplete: 'off', inputmode: 'numeric' });
        const body = h('div');
        function showStatement() {
          const a = auth.account;
          if (!a) return;
          try {
            const s = api.getStatement({ account: a, auth_token: auth.accountToken });
            const amt = h('input', { inputmode: 'decimal', value: (s.total_due_toea / 100).toFixed(2) });
            const chan = select(chOpts.filter(([id]) => id !== 'telco'), 'wallet');
            const btn = h('button', { class: 'btn', type: 'button' }, 'Pay statement');
            const res = h('div', { 'aria-live': 'polite' });
            btn.addEventListener('click', () => {
              let amount;
              try { amount = parseKina(amt.value); } catch (e) { return fail(e); }
              try {
                const p = api.createPayment({ kind: 'POSTPAID', account: a, amount_toea: amount, channel: chan.value, idempotency_key: newKey(), auth_token: auth.accountToken });
                openGateway(p, (r) => {
                  if (r.payment.status === 'SETTLED') { res.replaceChildren(h('div', { class: 'notice ok' }, 'Payment received: ' + money(r.payment.amount_toea) + '. The statement is updated.')); showStatement(); }
                  else if (r.payment.status === 'PENDING') res.replaceChildren(h('div', { class: 'notice warn' }, 'Payment not confirmed yet. Your balance has not changed.'));
                  else res.replaceChildren(h('div', { class: 'notice bad' }, r.payment.failure_reason || 'Payment failed.'));
                }, () => {});
              } catch (e) { fail(e); }
            });
            body.replaceChildren(
              h('h3', { style: 'font-size:15px' }, s.holder + ' · total due ' + money(s.total_due_toea)),
              table(['Invoice', 'Period', 'Due date', 'Outstanding'], s.invoices.map((i) => h('tr', null, h('td', { class: 'mono' }, i.id), h('td', null, i.period), h('td', null, i.due_date), h('td', null, money(i.outstanding_toea))))),
              s.total_due_toea > 0
                ? h('div', { style: 'margin-top:10px' }, field('Amount to pay (kina, up to total due)', amt), field('Payment channel', chan), h('div', { class: 'row', style: 'margin-top:10px' }, btn))
                : h('p', { class: 'notice ok' }, 'Nothing outstanding.'),
              res);
          } catch (e) { fail(e); }
        }
        const unlock = () => {
          try {
            const s = api.verifyAccount(acc.value.trim(), pin.value);
            auth.account = acc.value.trim(); auth.accountToken = s.auth_token; pin.value = '';
            showStatement();
          } catch (e) { fail(e); }
        };
        return h('div', { class: 'card' },
          h('h2', null, 'Postpaid account'),
          h('p', { class: 'muted' }, 'For business accounts. Enter the account number and PIN to see the statement.'),
          field('Account number', acc), field('Account PIN', pin),
          h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn ghost', type: 'button', onclick: unlock }, 'Unlock statement')),
          body);
      }
    }
  };

  // Simulated payment provider. The outcome is chosen by the user, so every path can be tested.
  function openGateway(p, onDone, onClose) {
    const cfg = api.getConfig();
    const ch = cfg.channels.find((c) => c.id === p.channel);
    let close = () => {};
    const act = (outcome) => {
      try {
        const r = api.gatewayRespond(p.id, outcome);
        close(); onClose && onClose();
        onDone(r, outcome);
      } catch (e) { fail(e); }
    };
    const card = h('div', { class: 'card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gw-title' },
      h('h2', { id: 'gw-title' }, 'Simulated payment provider'),
      h('p', null, 'Paying ' + money(p.total_toea) + ' via ' + (ch ? ch.label : p.channel) + ' for ' + p.ref + '.'),
      h('p', { class: 'muted' }, 'Choose what the provider returns. No money moves in this demo.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: () => act('approve') }, 'Approve'),
        h('button', { class: 'btn bad', type: 'button', onclick: () => act('decline') }, 'Decline'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => act('noresponse') }, 'No response')),
      h('p', { class: 'muted', style: 'margin-top:10px' }, '"No response" leaves the payment pending, so you can test the status check.'));
    close = openModal(card);
  }

  // ---------- FAULTS & TRACKER ----------
  views.tracker = {
    render(root) {
      const cfg = api.getConfig();
      const cats = Object.keys(cfg.fault_cats).map((k) => [k, cfg.fault_cats[k].label]);
      const subs = cfg.suburbs.map((s) => [s.id, s.name]);
      const catIn = select(cats, 'AREA_BLACKOUT');
      const subIn = select(subs, 'boroko');
      const poleIn = h('input', { placeholder: 'e.g. POM-A12-04 (optional)', autocomplete: 'off' });
      const addrIn = h('input', { placeholder: 'Street, house, landmark', maxlength: '160' });
      const detIn = h('textarea', { maxlength: '300', placeholder: 'What do you see or hear?' });
      const reportOut = h('div', { 'aria-live': 'polite' });
      const submitBtn = h('button', { class: 'btn', type: 'button' }, 'Submit report');

      submitBtn.addEventListener('click', () => {
        submitBtn.disabled = true;
        try {
          const r = api.createFault({ idempotency_key: newKey(), category: catIn.value, suburb_id: subIn.value, pole_tag: poleIn.value.trim(), address_text: addrIn.value.trim(), details: detIn.value.trim() });
          const lines = [];
          lines.push(r.deduplicated
            ? h('p', null, 'This matches an open report, ' + r.distance_m + ' m away. Your details were added to ticket ' + r.ticket.ticket_id + '.')
            : h('p', null, 'Your ticket number is ' + r.ticket.ticket_id + '. Keep it to track progress.'));
          if (r.note) lines.push(h('p', { class: 'muted' }, r.note));
          if (r.nearby_area_outage) lines.push(h('p', { class: 'muted' }, 'An area outage (' + r.nearby_area_outage + ') is open nearby.'));
          reportOut.replaceChildren(h('div', { class: 'notice ok' }, lines));
          poleIn.value = ''; addrIn.value = ''; detIn.value = '';
          renderList();
        } catch (e) { fail(e); } finally { submitBtn.disabled = false; }
      });

      // track a ticket
      const tid = h('input', { placeholder: 'e.g. FLT-10001 or RPU-10003', autocomplete: 'off' });
      const tcode = h('input', { placeholder: 'Access code (tip-offs only)', autocomplete: 'off' });
      const trackOut = h('div', { 'aria-live': 'polite' });
      function track() {
        try {
          const t = api.trackTicket({ ticket_id: tid.value.trim(), access_code: tcode.value.trim() });
          const latest = t.timeline.length ? t.timeline[t.timeline.length - 1].at : t.updated_at;
          trackOut.replaceChildren(h('div', { class: 'card', style: 'margin-top:10px' },
            h('div', { class: 'row', style: 'justify-content:space-between' },
              h('strong', { class: 'mono' }, t.ticket_id), h('span', null, prioPill(t.priority), ' ', pill(t.stage, t.terminal ? '' : 'ok'))),
            kvs([
              ['Type', t.category_label],
              ['Area', t.suburb_name + ' · ' + t.grid_name],
              ['Updated', fmtTime(latest)],
              ['Crew', t.crew || 'Not yet assigned']
            ]),
            stageBar(t),
            t.timeline.length ? h('ul', { class: 'timeline' }, t.timeline.map((x) => h('li', null, x.stage, ' · ', h('span', { class: 'muted' }, fmtTime(x.at))))) : null));
        } catch (e) { trackOut.replaceChildren(); fail(e); }
      }

      // live list
      const q = h('input', { placeholder: 'Search area, pole or ticket', 'aria-label': 'Search faults' });
      const pf = select([['all', 'All priorities'], ['P1', 'P1 hazards'], ['P2', 'P2'], ['P3', 'P3']], 'all');
      const listBox = h('div');
      function renderList() {
        const rows = api.searchFaults({ q: q.value }).filter((t) => pf.value === 'all' || t.priority === pf.value);
        listBox.replaceChildren(table(['Ticket', 'Type', 'Area', 'Stage', 'Priority', 'Updated'],
          rows.map((t) => h('tr', null, h('td', { class: 'mono' }, t.ticket_id), h('td', null, t.category_label), h('td', null, t.suburb_name, t.pole_tag ? h('div', { class: 'muted mono' }, t.pole_tag) : null), h('td', null, pill(t.stage, t.terminal ? '' : 'ok')), h('td', null, prioPill(t.priority)), h('td', null, fmtTime(t.updated_at))))));
      }
      q.addEventListener('input', renderList);
      pf.addEventListener('change', renderList);
      tid.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') track(); });

      root.append(
        h('h1', null, 'Faults & Tracker'),
        h('p', { class: 'sub' }, 'Report a power problem, follow a ticket, and see what is open in the network right now.'),
        h('div', { class: 'split' },
          h('div', { class: 'card' },
            h('h2', null, 'Report a fault'),
            h('p', { class: 'muted' }, 'If someone is in danger or there is a fallen or sparking line, call the hotline now and do not wait for the form.'),
            field('Fault type', catIn), field('Suburb or town', subIn), field('Pole tag', poleIn),
            field('Address or landmark', addrIn), field('Details', detIn),
            h('div', { class: 'row', style: 'margin-top:10px' }, submitBtn),
            reportOut),
          h('div', { class: 'card' },
            h('h2', null, 'Track a ticket'),
            field('Ticket number', tid), field('Access code (tip-offs only)', tcode),
            h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn ghost', type: 'button', onclick: track }, 'Track')),
            trackOut)),
        h('div', { class: 'card', style: 'margin-top:14px' },
          h('h2', null, 'Open and recent faults'),
          h('div', { class: 'row' }, field('Search', q), field('Priority', pf)),
          listBox)
      );
      renderList();
      current.live = renderList;
    }
  };

  // expose internals for the other UI file
  window.StepwiseUI = { api, bot, h, $, money, fmtTime, newKey, parseKina, toast, fail, errMsg, go, views, auth, NAV, applyBrand, buildNav, route, table, kvs, field, select, pill, prioPill, stageBar, openModal, tokenNode, ledNode, breakdown, openGateway, get current() { return current; }, setLive(fn) { if (current) current.live = fn; } };
  buildNav();
  applyBrand();
  updateStorageNote();
  if (!location.hash) location.hash = '#dashboard';
  route();
})();
