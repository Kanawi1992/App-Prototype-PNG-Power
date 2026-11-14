
  // =====================================================================
  function create(opts) {
    opts = opts || {};
    const nowFn = opts.now || (() => new Date());
    const rng = opts.rng || defaultRng;
    const storage = makeStorage(opts.storage);
    const listeners = [];
    let db = null, lastRaw = null;

    const iso = () => nowFn().toISOString();
    const ms = (s) => new Date(s).getTime();
    const E = (code, msg, status) => new ApiError(code, msg, status);

    function randFrom(alpha, n) {
      let out = '';
      while (out.length < n) {
        const bytes = rng(n * 2);
        for (const b of bytes) { if (b < 256 - (256 % alpha.length) && out.length < n) out += alpha[b % alpha.length]; }
      }
      return out;
    }
    const randDigits = (n) => randFrom('0123456789', n);
    const hashSecret = (secret, salt) => sha256(salt + ':' + secret);
    const next = (w, name, start) => { w.counters[name] = (w.counters[name] === undefined ? (start || 0) : w.counters[name]) + 1; return w.counters[name]; };
    const kina = (t) => 'K' + (t / 100).toFixed(2);

    function audit(w, actor, action, entity, detail) {
      w.audit.push({ id: 'AUD-' + pad(next(w, 'aud'), 6), at: iso(), actor: actor || 'system', action, entity: entity || '', detail: detail || '' });
      if (w.audit.length > 500) w.audit.splice(0, w.audit.length - 500);
    }

    // ---------- persistence ----------
    function emit() { listeners.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } }); }
    function persist(w) { const text = JSON.stringify(w); storage.set(DB_KEY, text); lastRaw = text; }
    function refresh() {
      const raw = storage.get(DB_KEY);
      if (db && raw === lastRaw) return;
      if (raw == null) { if (!db) db = seedDb(); persist(db); return; }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.meta || parsed.meta.schema !== SCHEMA_VERSION) throw new Error('schema');
        db = parsed; lastRaw = raw;
      } catch (e) {
        try { storage.set(DB_KEY + '_corrupt', raw); } catch (e2) { /* ignore */ }
        db = seedDb(); persist(db);
      }
    }
    function transact(fn) {
      refresh();
      const w = clone(db);
      sweep(w);
      const out = fn(w);
      w.meta.rev = (db.meta.rev || 0) + 1;
      w.meta.updated_at = iso();
      try { persist(w); } catch (e) {
        throw E('STORAGE_FULL', 'Could not save to browser storage (full or blocked). Nothing was changed.', 507);
      }
      db = w;
      emit();
      if (out && out.__err) throw out.__err;
      return out;
    }
    function read() { refresh(); return db; }

    function sweep(w) {
      const t = nowFn().getTime();
      for (const p of w.payments) {
        if (p.status === 'PENDING' && ms(p.expires_at) <= t) { p.status = 'EXPIRED'; p.failure_reason = 'No confirmation received in time'; }
      }
      for (const k of Object.keys(w.sessions)) if (ms(w.sessions[k].expires_at) <= t) delete w.sessions[k];
      const ids = Object.keys(w.idem);
      if (ids.length > 300) ids.slice(0, ids.length - 300).forEach((k) => delete w.idem[k]);
    }

    // ---------- auth / sessions / lockouts ----------
    function makeSession(w, scope, extra, minutes) {
      const token = randFrom(ALPHA32, 32);
      const expires_at = new Date(nowFn().getTime() + minutes * MIN).toISOString();
      w.sessions[token] = Object.assign({ scope, expires_at }, extra || {});
      return { token, expires_at };
    }
    function lockCheck(w, key) {
      const l = w.locks[key];
      if (l && l.until && ms(l.until) > nowFn().getTime()) {
        const mins = Math.ceil((ms(l.until) - nowFn().getTime()) / MIN);
        return E('LOCKED', 'Too many failed attempts. Try again in ' + mins + ' minute(s).', 429);
      }
      return null;
    }
    function lockFail(w, key) {
      const l = w.locks[key] = w.locks[key] || { fails: 0, until: null };
      if (l.until && ms(l.until) <= nowFn().getTime()) { l.fails = 0; l.until = null; }
      l.fails += 1;
      if (l.fails >= 5) { l.until = new Date(nowFn().getTime() + 10 * MIN).toISOString(); l.fails = 0; }
    }
    function sessionOk(w, token, scope) {
      const s = token && w.sessions[token];
      return !!(s && s.scope === scope && ms(s.expires_at) > nowFn().getTime());
    }
    function staffSession(w, token, roles) {
      const s = token && w.sessions[token];
      if (!s || s.scope !== 'STAFF' || ms(s.expires_at) <= nowFn().getTime()) throw E('AUTH_REQUIRED', 'Please sign in to the staff console.', 401);
      if (roles && !roles.includes(s.role)) throw E('FORBIDDEN', 'Your role (' + s.role + ') cannot do this.', 403);
      return s;
    }
    const touch = (s) => { s.expires_at = new Date(nowFn().getTime() + 30 * MIN).toISOString(); };

    // ---------- billing core ----------
    function validateMeter(w, num) {
      num = String(num || '').trim();
      if (!/^\d{11}$/.test(num)) throw E('METER_FORMAT', 'Meter number must be exactly 11 digits.');
      if (!luhnValid(num)) throw E('METER_CHECKSUM', 'That meter number has an invalid check digit. Please re-check it.');
      const m = w.meters.find((x) => x.meter_number === num);
      if (!m) throw E('METER_UNKNOWN', 'No meter with that number is registered.', 404);
      if (m.status !== 'ACTIVE') throw E('METER_BLOCKED', 'This meter is blocked from vending. Please contact a customer service centre.', 403);
      return m;
    }
    function computeQuote(w, meter, amount, channelId) {
      const ch = w.config.channels.find((c) => c.id === channelId);
      if (!ch) throw E('CHANNEL_INVALID', 'Unknown payment channel.');
      if (!Number.isInteger(amount) || amount <= 0) throw E('AMOUNT_INVALID', 'Enter a valid amount.');
      if (amount < ch.min_toea) throw E('AMOUNT_LIMIT', 'Minimum for this channel is ' + kina(ch.min_toea) + '.');
      if (amount > ch.max_toea) throw E('AMOUNT_LIMIT', 'Maximum for this channel is ' + kina(ch.max_toea) + '.');
      const bp = w.config.gst_bp;
      const fee = ch.fee_toea + Math.round(amount * (ch.fee_pct || 0));
      const gst = Math.round(amount * bp / (10000 + bp));
      const energy = amount - gst;
      const rate = w.config.tariffs[meter.tariff].rate_toea;
      const kwh = Math.floor(energy * 100 / rate) / 100;
      return { amount_toea: amount, gst_toea: gst, energy_toea: energy, fee_toea: fee, total_toea: amount + fee, rate_toea: rate, kwh, channel: ch.id, channel_label: ch.label };
    }
    function outstanding(inv) { return inv.amount_toea - inv.paid_toea; }
    function accountDue(acc) { return acc.invoices.reduce((s, i) => s + outstanding(i), 0); }

    function doCreatePayment(w, input, at) {
      const key = String(input.idempotency_key || '');
      if (key.length < 8 || key.length > 64) throw E('IDEM_REQUIRED', 'Missing request key.');
      const kind = input.kind;
      const sig = [kind, input.meter_number || input.account, input.amount_toea, input.channel].join('|');
      if (w.idem[key]) {
        const ex = w.payments.find((p) => p.id === w.idem[key].payment_id);
        if (ex && w.idem[key].sig === sig) return ex;
        throw E('IDEM_MISMATCH', 'This request key was already used for a different request.', 409);
      }
      let ref, q, amount;
      if (kind === 'VEND') {
        const m = validateMeter(w, input.meter_number);
        q = computeQuote(w, m, input.amount_toea, input.channel);
        ref = m.meter_number; amount = q.amount_toea;
      } else if (kind === 'POSTPAID') {
        const acc = w.postpaid_accounts.find((a) => a.account === input.account);
        if (!acc) throw E('ACCOUNT_UNKNOWN', 'Account not found.', 404);
        const due = accountDue(acc);
        amount = input.amount_toea;
        if (!Number.isInteger(amount) || amount < 100) throw E('AMOUNT_INVALID', 'Enter an amount of at least K1.00.');
        if (due <= 0) throw E('NOTHING_DUE', 'This account has nothing outstanding.');
        if (amount > due) throw E('OVERPAY', 'Amount exceeds the outstanding balance of ' + kina(due) + '.');
        const ch = w.config.channels.find((c) => c.id === input.channel);
        if (!ch) throw E('CHANNEL_INVALID', 'Unknown payment channel.');
        ref = acc.account;
        q = { fee_toea: ch.fee_toea + Math.round(amount * (ch.fee_pct || 0)), channel: ch.id };
      } else throw E('KIND_INVALID', 'Unknown payment type.');
      const p = {
        id: 'PAY-' + randFrom(ALPHA32, 10), idem_key: key, kind, ref, amount_toea: amount, fee_toea: q.fee_toea,
        total_toea: amount + q.fee_toea, channel: q.channel, status: 'PENDING', created_at: at,
        expires_at: new Date(ms(at) + 15 * MIN).toISOString(), settled_at: null, failure_reason: null, tx_ref: null, alloc: null
      };
      w.payments.push(p);
      w.idem[key] = { payment_id: p.id, sig };
      audit(w, 'customer', 'PAYMENT_CREATED', p.id, kind + ' ' + ref + ' ' + kina(amount));
      return p;
    }

    function uniqueToken(w) {
      for (let tries = 0; tries < 20; tries++) {
        const d = randDigits(20);
        const t = d.match(/.{4}/g).join('-');
        if (!w.vend_transactions.some((x) => x.token === t)) return t;
      }
      throw E('TOKEN_GEN', 'Could not generate a unique token.', 500);
    }

    // returns {payment, tx?, alloc?}; never throws for business failures after payment exists
    function doSettle(w, p, at) {
      if (p.status === 'SETTLED') return { payment: p, tx: w.vend_transactions.find((t) => t.tx_ref === p.tx_ref) || null };
      if (p.status !== 'PENDING') throw E('INVALID_STATE', 'Payment is ' + p.status.toLowerCase() + ' and cannot be settled.', 409);
      if (p.kind === 'VEND') {
        const m = w.meters.find((x) => x.meter_number === p.ref);
        if (!m || m.status !== 'ACTIVE') {
          p.status = 'FAILED'; p.failure_reason = 'Meter became unavailable - payment will be refunded (simulated)';
          audit(w, 'system', 'PAYMENT_FAILED', p.id, p.failure_reason);
          return { payment: p, tx: null };
        }
        const q = computeQuote(w, m, p.amount_toea, p.channel);
        const tx = {
          tx_ref: 'TX-' + pad(next(w, 'tx', 884000), 6), payment_id: p.id, meter_number: m.meter_number,
          amount_toea: q.amount_toea, gst_toea: q.gst_toea, energy_toea: q.energy_toea, rate_toea: q.rate_toea,
          kwh: q.kwh, token: uniqueToken(w), channel: p.channel, created_at: at
        };
        w.vend_transactions.push(tx);
        m.balance_kwh = Math.round((m.balance_kwh + q.kwh) * 100) / 100;
        m.credited_kwh_total = Math.round((m.credited_kwh_total + q.kwh) * 100) / 100;
        p.status = 'SETTLED'; p.settled_at = at; p.tx_ref = tx.tx_ref;
        audit(w, 'system', 'TOKEN_VENDED', tx.tx_ref, m.meter_number + ' +' + q.kwh + ' kWh');
        return { payment: p, tx };
      }
      const acc = w.postpaid_accounts.find((a) => a.account === p.ref);
      let left = p.amount_toea; const alloc = [];
      for (const inv of acc.invoices.slice().sort((a, b) => a.due_date.localeCompare(b.due_date))) {
        const take = Math.min(left, outstanding(inv));
        if (take > 0) { inv.paid_toea += take; left -= take; alloc.push({ invoice_id: inv.id, amount_toea: take }); }
      }
      p.alloc = alloc; p.status = 'SETTLED'; p.settled_at = at;
      audit(w, 'system', 'POSTPAID_SETTLED', p.id, acc.account + ' ' + kina(p.amount_toea));
      return { payment: p, tx: null };
    }
