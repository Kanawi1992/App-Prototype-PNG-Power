
    // =====================================================================
    // PUBLIC API
    // =====================================================================
    const effStatus = (p) => (p.status === 'PENDING' && ms(p.expires_at) <= nowFn().getTime() ? 'EXPIRED' : p.status);
    function pubPayment(w, p) {
      const ch = w.config.channels.find((c) => c.id === p.channel);
      return {
        id: p.id, kind: p.kind, status: effStatus(p), ref: p.ref, amount_toea: p.amount_toea, fee_toea: p.fee_toea,
        total_toea: p.total_toea, channel: p.channel, channel_label: ch ? ch.label : p.channel, created_at: p.created_at,
        expires_at: p.expires_at, settled_at: p.settled_at, failure_reason: p.failure_reason, tx_ref: p.tx_ref, alloc: p.alloc
      };
    }
    function receipt(w, res) {
      const out = { payment: pubPayment(w, res.payment), tx: null };
      if (res.tx) {
        out.tx = { tx_ref: res.tx.tx_ref, meter_number: res.tx.meter_number, token: res.tx.token, kwh: res.tx.kwh,
          amount_toea: res.tx.amount_toea, gst_toea: res.tx.gst_toea, energy_toea: res.tx.energy_toea, created_at: res.tx.created_at };
        const m = w.meters.find((x) => x.meter_number === res.tx.meter_number);
        out.meter_led = ledFor(m);
      }
      return out;
    }
    const findPayment = (w, id) => {
      const p = w.payments.find((x) => x.id === id);
      if (!p) throw E('NOT_FOUND', 'Payment not found.', 404);
      return p;
    };
    function pubTicket(w, t) {
      const sub = w.config.suburbs.find((s) => s.id === t.suburb_id);
      const stages = STAGES[t.kind];
      const idx = stages.indexOf(t.stage);
      const timeline = w.ticket_events.filter((e) => e.ticket_id === t.ticket_id && e.to !== e.from).map((e) => ({ at: e.at, stage: e.to }));
      const out = {
        ticket_id: t.ticket_id, kind: t.kind, stage: t.stage, stages, stage_index: idx, priority: t.kind === 'FAULT' ? t.priority : null,
        suburb_name: sub ? sub.name : '', grid_name: w.config.grids[t.grid].name, created_at: t.created_at, updated_at: t.updated_at,
        timeline, terminal: isTerminal(t)
      };
      if (t.kind === 'FAULT') {
        out.category_label = w.config.fault_cats[t.category].label; out.reports = t.reports.length; out.pole_tag = t.pole_tag;
        out.crew = idx >= 2 ? t.assigned_crew : '';
      } else out.category_label = 'Confidential report';
      return out;
    }

    const api = {
      on(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
      reload() { refresh(); emit(); },
      health() {
        const d = read();
        return { persistent: storage.persistent, rev: d.meta.rev, updated_at: d.meta.updated_at, bytes: (lastRaw || '').length, schema: d.meta.schema };
      },
      getBrand() { return clone(read().brand); },
      getConfig() {
        const c = read().config;
        return clone({ channels: c.channels, suburbs: c.suburbs, grids: c.grids, fault_cats: c.fault_cats, tip_cats: c.tip_cats, tariffs: c.tariffs, offices: c.offices, target_min: c.target_min, gst_bp: c.gst_bp, poles: c.poles.map((p) => ({ tag: p.tag, suburb: p.suburb })) });
      },
      demoCredentials() { const c = read().config; return c.show_demo_credentials ? clone(c.demo_credentials) : null; },
      getStats() {
        const d = read();
        const open = d.tickets.filter((t) => t.kind === 'FAULT' && !isTerminal(t));
        return {
          tokens: d.vend_transactions.length, kwh: Math.round(d.vend_transactions.reduce((s, t) => s + t.kwh, 0) * 100) / 100,
          open_faults: open.length, open_p1: open.filter((t) => t.priority === 'P1').length
        };
      },
      lookupMeter(num) {
        const d = read();
        const m = validateMeter(Object.assign({}, d, {}), num);
        const mask = (s) => s.split(' ').map((x) => x[0] + '***').join(' ');
        const tar = d.config.tariffs[m.tariff];
        return { meter_number: m.meter_number, holder_masked: mask(m.holder), tariff_label: tar.label, rate_toea: tar.rate_toea, feeder: m.feeder, led: ledFor(m) };
      },
      quote(input) {
        const d = read();
        const m = validateMeter(d, input.meter_number);
        return computeQuote(d, m, input.amount_toea, input.channel);
      },
      createPayment(input) {
        if (input.kind === 'POSTPAID') {
          const d = read();
          if (!sessionOk(d, input.auth_token, 'ACC:' + input.account)) throw E('AUTH_REQUIRED', 'Please unlock the account with its PIN first.', 401);
        }
        return transact((w) => pubPayment(w, doCreatePayment(w, input, iso())));
      },
      getPayment(id) { const d = read(); return pubPayment(d, findPayment(d, id)); },
      gatewayRespond(id, outcome) {
        return transact((w) => {
          const p = findPayment(w, id);
          if (p.status === 'SETTLED') return receipt(w, doSettle(w, p, iso()));
          if (p.status !== 'PENDING') throw E('INVALID_STATE', 'This payment is ' + p.status.toLowerCase() + '. Please start a new purchase.', 409);
          if (outcome === 'approve') return receipt(w, doSettle(w, p, iso()));
          if (outcome === 'decline') {
            p.status = 'FAILED'; p.failure_reason = 'Declined by the payment provider (simulated: insufficient funds)';
            audit(w, 'gateway', 'PAYMENT_DECLINED', p.id, p.ref);
            return receipt(w, { payment: p });
          }
          if (outcome === 'noresponse') { audit(w, 'gateway', 'PAYMENT_NO_RESPONSE', p.id, p.ref); return receipt(w, { payment: p }); }
          throw E('VALIDATION', 'Unknown gateway outcome.');
        });
      },
      // simulates the provider's late "payment confirmed" callback / status query
      reconcilePayment(id) {
        return transact((w) => {
          const p = findPayment(w, id);
          if (p.status === 'SETTLED') return receipt(w, doSettle(w, p, iso()));
          if (p.status !== 'PENDING') return { __err: E('INVALID_STATE', 'This payment ' + (p.status === 'EXPIRED' ? 'expired before it was confirmed. No money was taken (simulated).' : 'failed: ' + (p.failure_reason || '')), 409) };
          return receipt(w, doSettle(w, p, iso()));
        });
      },
      verifyMeter(num, pin) { return verifySubject('METER', String(num || '').trim(), pin); },
      verifyAccount(acc, pin) { return verifySubject('ACC', String(acc || '').trim(), pin); },
      listVendHistory(input) {
        const d = read();
        const num = String(input.meter_number || '').trim();
        const staff = input.auth_token && d.sessions[input.auth_token] && d.sessions[input.auth_token].scope === 'STAFF' && sessionOk(d, input.auth_token, 'STAFF');
        if (!staff && !sessionOk(d, input.auth_token, 'METER:' + num)) throw E('AUTH_REQUIRED', 'Enter the meter PIN to view token history.', 401);
        const m = d.meters.find((x) => x.meter_number === num);
        if (!m) throw E('METER_UNKNOWN', 'No meter with that number is registered.', 404);
        return {
          meter: api.lookupMeter(num),
          transactions: d.vend_transactions.filter((t) => t.meter_number === num).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50).map(clone),
          payments: d.payments.filter((p) => p.kind === 'VEND' && p.ref === num && effStatus(p) !== 'SETTLED').sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 10).map((p) => pubPayment(d, p))
        };
      },
      getStatement(input) {
        const d = read();
        if (!sessionOk(d, input.auth_token, 'ACC:' + input.account)) throw E('AUTH_REQUIRED', 'Enter the account PIN to view the statement.', 401);
        const a = d.postpaid_accounts.find((x) => x.account === input.account);
        if (!a) throw E('ACCOUNT_UNKNOWN', 'Account not found.', 404);
        return {
          account: a.account, holder: a.holder, total_due_toea: accountDue(a),
          invoices: a.invoices.map((i) => Object.assign(clone(i), { outstanding_toea: outstanding(i) })),
          payments: d.payments.filter((p) => p.kind === 'POSTPAID' && p.ref === a.account).sort((x, y) => y.created_at.localeCompare(x.created_at)).slice(0, 10).map((p) => pubPayment(d, p))
        };
      },
      createFault(input) {
        return transact((w) => {
          const key = String(input.idempotency_key || '');
          if (key.length < 8) throw E('IDEM_REQUIRED', 'Missing request key.');
          const hit = w.idem['T:' + key];
          if (hit) { const t = w.tickets.find((x) => x.ticket_id === hit.ticket_id); return { ticket: pubTicket(w, t), deduplicated: hit.dedup, distance_m: hit.distance_m, replay: true }; }
          const r = doCreateFault(w, input, iso(), 'customer');
          w.idem['T:' + key] = { ticket_id: r.ticket.ticket_id, dedup: r.deduplicated, distance_m: r.distance_m };
          return { ticket: pubTicket(w, r.ticket), deduplicated: r.deduplicated, distance_m: r.distance_m, note: r.note, nearby_area_outage: r.nearby_area_outage || null };
        });
      },
      createTip(input) {
        return transact((w) => {
          const key = String(input.idempotency_key || '');
          if (key.length < 8) throw E('IDEM_REQUIRED', 'Missing request key.');
          const hit = w.idem['T:' + key];
          if (hit) { const t = w.tickets.find((x) => x.ticket_id === hit.ticket_id); return { ticket_id: t.ticket_id, access_code: t.access_code, replay: true }; }
          const t = doCreateTip(w, input, iso());
          w.idem['T:' + key] = { ticket_id: t.ticket_id };
          return { ticket_id: t.ticket_id, access_code: t.access_code };
        });
      },
      trackTicket(input) {
        const d = read();
        const id = String(input.ticket_id || '').trim().toUpperCase();
        const t = d.tickets.find((x) => x.ticket_id === id);
        const nf = E('NOT_FOUND', 'No ticket found. For confidential reports, enter the access code you were given.', 404);
        if (!t) throw nf;
        if (t.kind === 'TIP' && String(input.access_code || '').trim().toUpperCase() !== t.access_code) throw nf;
        return pubTicket(d, t);
      },
      searchFaults(input) {
        const d = read();
        const q = norm(input && input.q);
        const day = nowFn().getTime() - 86400000;
        return d.tickets.filter((t) => t.kind === 'FAULT' && (!isTerminal(t) || ms(t.updated_at) > day)).map((t) => pubTicket(d, t))
          .filter((t) => !q || norm([t.ticket_id, t.suburb_name, t.pole_tag, t.category_label, t.grid_name].join(' ')).includes(q))
          .sort((a, b) => (a.terminal - b.terminal) || a.priority.localeCompare(b.priority) || b.created_at.localeCompare(a.created_at)).slice(0, 30);
      },
      getGrid() {
        const d = read(), now = nowFn();
        return Object.keys(d.config.grids).map((k) => {
          const meta = d.config.grids[k], st = gridStatus(d, k);
          const open = d.tickets.filter((t) => t.kind === 'FAULT' && t.grid === k && !isTerminal(t));
          return Object.assign({ key: k, status: st.status, source: st.source, load_mw: loadMw(d, k, now), open_faults: open.length, open_p1: open.filter((t) => t.priority === 'P1').length }, clone(meta));
        });
      },
      listNotices() { return clone(read().notices).sort((a, b) => b.posted_at.localeCompare(a.posted_at)); },
      listOffices() { return clone(read().config.offices); }
    };

    function verifySubject(kind, id, pin) {
      return transact((w) => {
        const key = kind + ':' + id;
        const locked = lockCheck(w, key);
        if (locked) return { __err: locked };
        const rec = kind === 'METER' ? w.meters.find((m) => m.meter_number === id) : w.postpaid_accounts.find((a) => a.account === id);
        if (!rec || rec.pin_hash !== hashSecret(String(pin || ''), id)) {
          lockFail(w, key);
          return { __err: E('BAD_CREDENTIALS', 'Incorrect number or PIN.', 401) };
        }
        delete w.locks[key];
        const s = makeSession(w, key, {}, 15);
        return { auth_token: s.token, expires_at: s.expires_at };
      });
    }
