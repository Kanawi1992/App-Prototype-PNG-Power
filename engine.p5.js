
    // ---------- staff API ----------
    function staffTicketView(w, t) {
      const target = w.config.target_min[t.priority];
      const age = Math.round((nowFn().getTime() - ms(t.created_at)) / MIN);
      const stages = STAGES[t.kind], idx = stages.indexOf(t.stage);
      const sub = w.config.suburbs.find((s) => s.id === t.suburb_id);
      return Object.assign(clone(t), {
        suburb_name: sub ? sub.name : '', grid_name: w.config.grids[t.grid].name, age_min: age, terminal: isTerminal(t),
        next_stage: isTerminal(t) ? null : stages[idx + 1], stages, stage_index: idx,
        category_label: t.kind === 'FAULT' ? w.config.fault_cats[t.category].label : w.config.tip_cats[t.category],
        overdue: t.kind === 'FAULT' && !isTerminal(t) && idx < 2 && age > target,
        events: w.ticket_events.filter((e) => e.ticket_id === t.ticket_id)
      });
    }
    const redactMeter = (m) => { const c = clone(m); c.pin_hash = '[hidden]'; return c; };

    Object.assign(api, {
      login(user, password) {
        return transact((w) => {
          const key = 'STAFF:' + String(user || '').toLowerCase();
          const locked = lockCheck(w, key);
          if (locked) return { __err: locked };
          const s = w.staff.find((x) => x.user === String(user || '').toLowerCase());
          if (!s || s.hash !== hashSecret(String(password || ''), 'staff:' + s.user)) {
            lockFail(w, key); audit(w, String(user || '?').slice(0, 30), 'LOGIN_FAILED', 'staff', '');
            return { __err: E('BAD_CREDENTIALS', 'Incorrect username or password.', 401) };
          }
          delete w.locks[key];
          const sess = makeSession(w, 'STAFF', { user: s.user, role: s.role }, 30);
          audit(w, s.user, 'LOGIN', 'staff', s.role);
          return { token: sess.token, user: s.user, role: s.role, expires_at: sess.expires_at };
        });
      },
      logout(token) { return transact((w) => { const s = w.sessions[token]; if (s) { audit(w, s.user, 'LOGOUT', 'staff', ''); delete w.sessions[token]; } return true; }); },
      whoami(token) { const d = read(); const s = staffSession(d, token); return { user: s.user, role: s.role, expires_at: s.expires_at }; },
      staffTickets(token, filter) {
        const d = read(); staffSession(d, token);
        filter = filter || {};
        const rank = { P1: 0, P2: 1, P3: 2 };
        return d.tickets.filter((t) => (!filter.kind || t.kind === filter.kind) && (filter.status === 'all' || !isTerminal(t)))
          .map((t) => staffTicketView(d, t))
          .sort((a, b) => (a.terminal - b.terminal) || (rank[a.priority] - rank[b.priority]) || a.created_at.localeCompare(b.created_at));
      },
      advanceTicket(token, id, note) {
        return transact((w) => {
          const s = staffSession(w, token, ['dispatcher', 'supervisor']); touch(s);
          const t = w.tickets.find((x) => x.ticket_id === id);
          if (!t) throw E('NOT_FOUND', 'Ticket not found.', 404);
          doAdvance(w, t, s.user, clean(note, 200, 'Note'), iso());
          audit(w, s.user, 'TICKET_ADVANCED', id, t.stage);
          return staffTicketView(w, t);
        });
      },
      cancelTicket(token, id, reason) {
        return transact((w) => {
          const s = staffSession(w, token, ['dispatcher', 'supervisor']); touch(s);
          const t = w.tickets.find((x) => x.ticket_id === id);
          if (!t) throw E('NOT_FOUND', 'Ticket not found.', 404);
          if (isTerminal(t)) throw E('INVALID_TRANSITION', id + ' is already ' + t.stage + '.', 409);
          const r = clean(reason, 200, 'A reason', true);
          addEvent(w, t, s.user, t.stage, 'Cancelled', r, iso());
          t.stage = 'Cancelled'; t.updated_at = iso();
          audit(w, s.user, 'TICKET_CANCELLED', id, r);
          return staffTicketView(w, t);
        });
      },
      setGridOverride(token, grid, status) {
        return transact((w) => {
          const s = staffSession(w, token, ['supervisor']); touch(s);
          if (!w.grid[grid]) throw E('NOT_FOUND', 'Unknown grid.', 404);
          if (status && !['Scheduled Inspection', 'Feeder Load Shedding'].includes(status)) throw E('VALIDATION', 'Invalid status.');
          w.grid[grid].override = status || null;
          audit(w, s.user, 'GRID_OVERRIDE', grid, status || 'cleared (automatic)');
          return true;
        });
      },
      postNotice(token, input) {
        return transact((w) => {
          const s = staffSession(w, token, ['supervisor']); touch(s);
          const cats = ['Planned Outages', 'Safety & Compliance', 'Corporate News'];
          if (!cats.includes(input.category)) throw E('VALIDATION', 'Choose a category.');
          const n = {
            id: 'N' + next(w, 'notice', 100), category: input.category, posted_at: iso(), region: clean(input.region, 80, 'Region', true),
            title: clean(input.title, 120, 'Title', true), summary: clean(input.summary, 200, 'Summary', true), body: [clean(input.body || input.summary, 1200, 'Body', true)]
          };
          w.notices.push(n); audit(w, s.user, 'NOTICE_POSTED', n.id, n.title);
          return n;
        });
      },
      deleteNotice(token, id) {
        return transact((w) => {
          const s = staffSession(w, token, ['supervisor']); touch(s);
          const i = w.notices.findIndex((n) => n.id === id);
          if (i < 0) throw E('NOT_FOUND', 'Notice not found.', 404);
          w.notices.splice(i, 1); audit(w, s.user, 'NOTICE_DELETED', id, '');
          return true;
        });
      },
      listPayments(token) {
        const d = read(); staffSession(d, token);
        return d.payments.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 100).map((p) => pubPayment(d, p));
      },
      financeReport(token) {
        const d = read(); staffSession(d, token);
        const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
        const txBy = {}; d.vend_transactions.forEach((t) => { txBy[t.tx_ref] = t; });
        const payBy = {}; d.payments.forEach((p) => { payBy[p.id] = p; });
        const settledV = d.payments.filter((p) => p.kind === 'VEND' && p.status === 'SETTLED');
        const settledP = d.payments.filter((p) => p.kind === 'POSTPAID' && p.status === 'SETTLED');
        const anomalies = [];
        settledV.forEach((p) => { if (!txBy[p.tx_ref]) anomalies.push('Settled payment ' + p.id + ' has no token record'); });
        const seen = new Set();
        d.vend_transactions.forEach((t) => {
          const p = payBy[t.payment_id];
          if (!p || p.status !== 'SETTLED') anomalies.push(t.tx_ref + ' has no settled payment');
          if (t.energy_toea + t.gst_toea !== t.amount_toea) anomalies.push(t.tx_ref + ': energy + GST does not equal amount');
          if (seen.has(t.token)) anomalies.push(t.tx_ref + ': duplicate token'); seen.add(t.token);
        });
        d.meters.forEach((m) => {
          const k = sum(d.vend_transactions.filter((t) => t.meter_number === m.meter_number), (t) => t.kwh);
          if (Math.abs(k - m.credited_kwh_total) > 0.005) anomalies.push('Meter ' + m.meter_number + ': credited kWh does not match token ledger');
        });
        d.postpaid_accounts.forEach((a) => a.invoices.forEach((inv) => {
          const paid = sum(settledP.filter((p) => p.ref === a.account), (p) => sum((p.alloc || []).filter((x) => x.invoice_id === inv.id), (x) => x.amount_toea));
          if (paid !== inv.paid_toea) anomalies.push('Invoice ' + inv.id + ': paid amount does not match payment allocations');
        }));
        const by = (st) => d.payments.filter((p) => effStatus(p) === st);
        return {
          vend: { count: settledV.length, amount_toea: sum(settledV, (p) => p.amount_toea), gst_toea: sum(d.vend_transactions, (t) => t.gst_toea), fees_toea: sum(settledV, (p) => p.fee_toea), kwh: Math.round(sum(d.vend_transactions, (t) => t.kwh) * 100) / 100 },
          postpaid: { count: settledP.length, amount_toea: sum(settledP, (p) => p.amount_toea) },
          pending: { count: by('PENDING').length, amount_toea: sum(by('PENDING'), (p) => p.total_toea) },
          failed: { count: by('FAILED').length }, expired: { count: by('EXPIRED').length },
          anomalies
        };
      },
      auditLog(token) { const d = read(); staffSession(d, token, ['supervisor']); return clone(d.audit).reverse().slice(0, 200); },
      inspectTable(token, name) {
        const d = read(); staffSession(d, token, ['supervisor']);
        const tables = {
          meters: () => d.meters.map(redactMeter), vend_transactions: () => d.vend_transactions, payments: () => d.payments.map((p) => Object.assign({}, p, { idem_key: '[hidden]' })),
          tickets: () => d.tickets, ticket_events: () => d.ticket_events, grid: () => d.grid, notices: () => d.notices
        };
        if (!tables[name]) throw E('NOT_FOUND', 'Unknown table.', 404);
        return clone(tables[name]());
      },
      updateBrand(token, input) {
        return transact((w) => {
          const s = staffSession(w, token, ['supervisor']); touch(s);
          const color = String(input.color || '').trim();
          if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw E('VALIDATION', 'Colour must be a hex value like #0f5f73.');
          w.brand = { name: clean(input.name, 40, 'Utility name', true), tagline: clean(input.tagline, 60, 'Tagline', true), hotline: clean(input.hotline, 40, 'Hotline', true), color };
          audit(w, s.user, 'BRAND_UPDATED', 'brand', w.brand.name);
          return clone(w.brand);
        });
      },
      setDemoCredentialsVisible(token, on) {
        return transact((w) => { const s = staffSession(w, token, ['supervisor']); touch(s); w.config.show_demo_credentials = !!on; audit(w, s.user, 'DEMO_CREDS', 'config', on ? 'shown' : 'hidden'); return true; });
      },
      exportDb(token) {
        const d = read(); staffSession(d, token, ['supervisor']);
        const c = clone(d); c.sessions = {}; c.idem = {}; c.locks = {}; c.staff = c.staff.map((x) => ({ user: x.user, role: x.role }));
        c.meters = c.meters.map(redactMeter); c.postpaid_accounts.forEach((a) => { a.pin_hash = '[hidden]'; }); c.config.demo_credentials = {};
        return JSON.stringify(c, null, 2);
      },
      resetDemo(token) {
        refresh();
        const s0 = staffSession(db, token, ['supervisor']);
        const fresh = seedDb();
        fresh.sessions[token] = Object.assign({}, db.sessions[token]);
        fresh.config.show_demo_credentials = db.config.show_demo_credentials;
        fresh.brand = clone(db.brand);
        audit(fresh, s0.user, 'RESET', 'db', 'Demo data reset');
        return transact((w) => { Object.keys(w).forEach((k) => delete w[k]); Object.assign(w, fresh); return true; });
      }
    });

    refresh();
    return api;
  }

  return { create, ApiError, luhnValid, luhnCheckDigit, haversineM, sha256, DB_KEY, STAGES };
});
