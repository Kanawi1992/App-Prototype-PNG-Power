(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StepwiseEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA_VERSION = 2;
  const DB_KEY = 'stepwise_utility_demo_db_v2';
  const TZ = 'Pacific/Port_Moresby';
  const MIN = 60000;

  class ApiError extends Error {
    constructor(code, message, status) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
      this.status = status || 400;
    }
  }

  // ---------- small helpers ----------
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const pad = (n, w) => String(n).padStart(w, '0');

  function luhnCheckDigit(base) {
    let sum = 0, dbl = true;
    for (let i = base.length - 1; i >= 0; i--) {
      let d = +base[i];
      if (dbl) { d *= 2; if (d > 9) d -= 9; }
      sum += d; dbl = !dbl;
    }
    return String((10 - (sum % 10)) % 10);
  }
  function luhnValid(num) {
    if (!/^\d+$/.test(num)) return false;
    let sum = 0, dbl = false;
    for (let i = num.length - 1; i >= 0; i--) {
      let d = +num[i];
      if (dbl) { d *= 2; if (d > 9) d -= 9; }
      sum += d; dbl = !dbl;
    }
    return sum % 10 === 0;
  }
  function haversineM(lat1, lng1, lat2, lng2) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function offsetLatLng(lat, lng, dxM, dyM) {
    return { lat: lat + dyM / 111320, lng: lng + dxM / (111320 * Math.cos(lat * Math.PI / 180)) };
  }

  // Pure-JS SHA-256 (sync). Demo-grade credential hashing only.
  function sha256(str) {
    const ascii = unescape(encodeURIComponent(String(str)));
    function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
    const pow = Math.pow, maxWord = pow(2, 32);
    let i, j, result = '';
    const words = [];
    const bitLen = ascii.length * 8;
    let hash = sha256.h = sha256.h || [];
    const k = sha256.k = sha256.k || [];
    let pc = k.length;
    const comp = {};
    for (let c = 2; pc < 64; c++) {
      if (!comp[c]) {
        for (i = 0; i < 313; i += c) comp[i] = c;
        hash[pc] = (pow(c, 0.5) * maxWord) | 0;
        k[pc++] = (pow(c, 1 / 3) * maxWord) | 0;
      }
    }
    let msg = ascii + '\x80';
    while (msg.length % 64 - 56) msg += '\x00';
    for (i = 0; i < msg.length; i++) {
      j = msg.charCodeAt(i);
      words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words.length] = ((bitLen / maxWord) | 0);
    words[words.length] = bitLen;
    for (j = 0; j < words.length;) {
      const w = words.slice(j, j += 16);
      const old = hash;
      hash = hash.slice(0, 8);
      for (i = 0; i < 64; i++) {
        const w15 = w[i - 15], w2 = w[i - 2];
        const a = hash[0], e = hash[4];
        const t1 = hash[7] + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & hash[5]) ^ (~e & hash[6])) + k[i] +
          (w[i] = (i < 16) ? w[i] : (w[i - 16] + (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))) | 0);
        const t2 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(t1 + t2) | 0].concat(hash);
        hash[4] = (hash[4] + t1) | 0;
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + old[i]) | 0;
    }
    for (i = 0; i < 8; i++) for (j = 3; j + 1; j--) {
      const b = (hash[i] >> (j * 8)) & 255;
      result += (b < 16 ? '0' : '') + b.toString(16);
    }
    return result;
  }

  function defaultRng(n) {
    const a = new Uint8Array(n);
    let c = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : null;
    if (!c && typeof require === 'function') c = require('node:crypto').webcrypto;
    if (!c) throw new Error('No secure random source available');
    c.getRandomValues(a);
    return a;
  }

  function makeStorage(ls) {
    let ok = false;
    const mem = new Map();
    if (ls) {
      try { ls.setItem('__sw_probe', '1'); ls.removeItem('__sw_probe'); ok = true; } catch (e) { ok = false; }
    }
    return {
      persistent: ok,
      get(k) { if (ok) { try { return ls.getItem(k); } catch (e) { return null; } } return mem.has(k) ? mem.get(k) : null; },
      set(k, v) { if (ok) ls.setItem(k, v); else mem.set(k, v); },
      remove(k) { if (ok) { try { ls.removeItem(k); } catch (e) { /* ignore */ } } else mem.delete(k); }
    };
  }

  // ---------- static demo configuration ----------
  const FAULT_CATS = {
    AREA_BLACKOUT: { label: 'Area / street blackout', priority: 'P2', group: 'AREA' },
    SINGLE_PREMISES: { label: 'Single premises - no power (credit available)', priority: 'P3', group: 'PREMISES' },
    HAZARD: { label: 'Sparking transformer / fallen or low wires', priority: 'P1', group: 'HAZARD' },
    POLE: { label: 'Damaged or leaning pole', priority: 'P2', group: 'POLE' }
  };
  const TIP_CATS = {
    HOOKUP: 'Illegal direct wire hook-up',
    TAMPER: 'Meter tampering / broken seal',
    BYPASS: 'Meter bypass / bridging',
    UNREGISTERED: 'Unregistered connection'
  };
  const STAGES = {
    FAULT: ['Logged', 'Verified', 'Crew Dispatched', 'On Site', 'Resolved'],
    TIP: ['Received', 'Under Review', 'Field Audit', 'Closed']
  };
  const TARGET_MIN = { P1: 30, P2: 240, P3: 480 };
  const POLE_RE = /^[A-Z]{3}-[A-Z]\d{1,2}-\d{1,3}$/;
  const ALPHA32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  const SUBURBS = [
    { id: 'boroko', name: 'Boroko', grid: 'capital', lat: -9.4790, lng: 147.1920 },
    { id: 'hohola', name: 'Hohola', grid: 'capital', lat: -9.4660, lng: 147.1830 },
    { id: 'gerehu', name: 'Gerehu', grid: 'capital', lat: -9.4020, lng: 147.1630 },
    { id: 'waigani', name: 'Waigani', grid: 'capital', lat: -9.4260, lng: 147.1840 },
    { id: 'four-mile', name: '4-Mile', grid: 'capital', lat: -9.4700, lng: 147.1570 },
    { id: 'badili', name: 'Badili', grid: 'capital', lat: -9.4780, lng: 147.1620 },
    { id: 'konedobu', name: 'Konedobu', grid: 'capital', lat: -9.4920, lng: 147.1480 },
    { id: 'gordons', name: 'Gordons', grid: 'capital', lat: -9.4400, lng: 147.2100 },
    { id: 'lae', name: 'Lae (Top Town)', grid: 'highlands', lat: -6.7300, lng: 146.9990 },
    { id: 'madang', name: 'Madang Town', grid: 'highlands', lat: -5.2250, lng: 145.7900 },
    { id: 'goroka', name: 'Goroka', grid: 'highlands', lat: -6.0830, lng: 145.3880 },
    { id: 'hagen', name: 'Mt. Hagen', grid: 'highlands', lat: -5.8600, lng: 144.2200 },
    { id: 'kokopo', name: 'Kokopo', grid: 'islands', lat: -4.3500, lng: 152.2640 },
    { id: 'kimbe', name: 'Kimbe', grid: 'islands', lat: -5.5500, lng: 150.1400 },
    { id: 'alotau', name: 'Alotau', grid: 'provincial', lat: -10.3100, lng: 150.4500 },
    { id: 'wewak', name: 'Wewak', grid: 'provincial', lat: -3.5500, lng: 143.6300 }
  ];
  const POLE_SEEDS = [
    ['POM-A12-04', 'waigani', 0, 0], ['POM-A12-05', 'waigani', 200, 100], ['POM-A12-40', 'waigani', 900, 0],
    ['POM-C4-12', 'four-mile', 50, -30], ['POM-G2-09', 'gerehu', -80, 120], ['POM-B14-08', 'boroko', 150, 60]
  ];
  const GRIDS = {
    capital: {
      name: 'Capital Grid', aliases: ['port moresby', 'moresby', 'ncd', 'capital'], capacity_mw: 150, base_mw: 112,
      specs: '66 kV transmission / 11 kV distribution (sample)',
      overview: 'Sample description: a hydro + gas + thermal mix serving the capital district. Replace with the client\'s verified figures.',
      mix: [{ label: 'Gas-fired baseload', pct: 56 }, { label: 'Hydropower', pct: 32 }, { label: 'Thermal reserve', pct: 12 }]
    },
    highlands: {
      name: 'Momase & Highlands Grid', aliases: ['highlands', 'momase', 'lae', 'madang', 'goroka', 'hagen', 'ramu'], capacity_mw: 130, base_mw: 91,
      specs: '132 kV / 66 kV backbone, 22 kV / 11 kV distribution (sample)',
      overview: 'Sample description: a long high-voltage corridor linking coastal and highland towns.',
      mix: [{ label: 'Hydropower', pct: 68 }, { label: 'Thermal & IPP', pct: 32 }]
    },
    islands: {
      name: 'Islands Grid', aliases: ['islands', 'new britain', 'kokopo', 'kimbe', 'rabaul', 'gazelle'], capacity_mw: 25, base_mw: 13,
      specs: '66 kV / 22 kV / 11 kV (sample)',
      overview: 'Sample description: a small regional grid with hydro and thermal backup.',
      mix: [{ label: 'Hydropower', pct: 62 }, { label: 'Thermal backup', pct: 38 }]
    },
    provincial: {
      name: 'Provincial Mini-Grids', aliases: ['provincial', 'alotau', 'wewak', 'mini-grid', 'c-centre'], capacity_mw: 60, base_mw: 44,
      specs: '22 kV / 11 kV primary distribution (sample)',
      overview: 'Sample description: isolated municipal grids, mostly diesel with solar hybrids.',
      mix: [{ label: 'Diesel generation', pct: 78 }, { label: 'Solar PV + battery', pct: 22 }]
    }
  };
  const CHANNELS = [
    { id: 'bank_ussd', label: 'Bank mobile banking (USSD)', fee_toea: 50, fee_pct: 0, min_toea: 1000, max_toea: 500000 },
    { id: 'wallet', label: 'Mobile wallet', fee_toea: 0, fee_pct: 0, min_toea: 1000, max_toea: 500000 },
    { id: 'telco', label: 'Telco airtime billing (USSD)', fee_toea: 0, fee_pct: 0, min_toea: 1500, max_toea: 5000 },
    { id: 'bank_pay', label: 'Bank pay app', fee_toea: 50, fee_pct: 0, min_toea: 1000, max_toea: 500000 },
    { id: 'card', label: 'Visa / Mastercard (web)', fee_toea: 0, fee_pct: 0.015, min_toea: 1000, max_toea: 500000 }
  ];
  const CREWS = [
    { id: 'c1', name: 'Capital North Line Crew', grid: 'capital', type: 'LINE' },
    { id: 'c2', name: 'Capital South Line Crew', grid: 'capital', type: 'LINE' },
    { id: 'c3', name: 'Highlands Line Crew', grid: 'highlands', type: 'LINE' },
    { id: 'c4', name: 'Islands Line Crew', grid: 'islands', type: 'LINE' },
    { id: 'c5', name: 'Provincial Line Crew', grid: 'provincial', type: 'LINE' },
    { id: 'r1', name: 'Revenue Protection Audit Team A', grid: 'capital', type: 'RPU' },
    { id: 'r2', name: 'Revenue Protection Audit Team B', grid: 'highlands', type: 'RPU' }
  ];
  const OFFICES = [
    ['Boroko Customer Service Centre', 'Port Moresby (Boroko)', 'Southern'],
    ['Hohola Main Customer Service Centre', 'Port Moresby (Hohola)', 'Southern'],
    ['Alotau Customer Service Centre', 'Alotau', 'Southern'],
    ['Lae Customer Service Centre', 'Lae', 'Momase'],
    ['Madang Customer Service Centre', 'Madang', 'Momase'],
    ['Wewak Customer Service Centre', 'Wewak', 'Momase'],
    ['Mt. Hagen Customer Service Centre', 'Mt. Hagen', 'Highlands'],
    ['Goroka Customer Service Centre', 'Goroka', 'Highlands'],
    ['Kokopo Customer Service Centre', 'Kokopo', 'New Guinea Islands'],
    ['Kimbe Customer Service Centre', 'Kimbe', 'New Guinea Islands']
  ].map(([name, town, region]) => ({
    name, town, region,
    address: 'Sample address - replace with the client\'s verified list',
    hours: 'Mon-Fri 8:00-16:30 (sample)'
  }));

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

    // ---------- tickets ----------
    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    function clean(s, max, field, required) {
      s = String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();
      if (required && s.length < 3) throw E('VALIDATION', field + ' is required.');
      if (s.length > max) throw E('VALIDATION', field + ' is too long (max ' + max + ' characters).');
      return s;
    }
    const addEvent = (w, t, actor, from, to, note, at) => w.ticket_events.push({
      id: 'EVT-' + pad(next(w, 'evt'), 6), ticket_id: t.ticket_id, at, actor, from, to, note: note || ''
    });
    const isTerminal = (t) => t.stage === 'Cancelled' || t.stage === STAGES[t.kind][STAGES[t.kind].length - 1];
    const findSuburb = (w, id) => {
      const s = w.config.suburbs.find((x) => x.id === id);
      if (!s) throw E('VALIDATION', 'Please choose a suburb / town from the list.');
      return s;
    };
    function pickCrew(w, kind, grid) {
      const type = kind === 'TIP' ? 'RPU' : 'LINE';
      const load = (c) => w.tickets.filter((t) => t.assigned_crew === c.name && !isTerminal(t)).length;
      const pool = w.config.crews.filter((c) => c.type === type);
      const local = pool.filter((c) => c.grid === grid);
      return (local.length ? local : pool).sort((a, b) => load(a) - load(b))[0].name;
    }
    function doAdvance(w, t, actor, note, at) {
      const stages = STAGES[t.kind], idx = stages.indexOf(t.stage);
      if (idx < 0 || idx === stages.length - 1) throw E('INVALID_TRANSITION', t.ticket_id + ' is already ' + t.stage + '.', 409);
      const to = stages[idx + 1];
      if (to === 'Crew Dispatched' || to === 'Field Audit') t.assigned_crew = pickCrew(w, t.kind, t.grid);
      addEvent(w, t, actor, t.stage, to, note, at);
      t.stage = to; t.updated_at = at;
    }
    function doCreateFault(w, input, at, actor) {
      const cat = FAULT_CATS[input.category];
      if (!cat) throw E('VALIDATION', 'Choose a fault type.');
      const sub = findSuburb(w, input.suburb_id);
      const address = clean(input.address_text, 160, 'Address / landmark', cat.group === 'PREMISES');
      const details = clean(input.details, 300, 'Details');
      const tag = String(input.pole_tag || '').trim().toUpperCase();
      let lat = sub.lat, lng = sub.lng, poleKnown = false, note = '';
      if (tag) {
        if (!POLE_RE.test(tag)) throw E('VALIDATION', 'Pole tag format looks like POM-A12-04.');
        const pole = w.config.poles.find((p) => p.tag === tag);
        if (pole) { lat = pole.lat; lng = pole.lng; poleKnown = true; if (pole.suburb !== sub.id) note = 'Pole tag is registered in another suburb; location taken from the pole.'; }
        else note = 'Pole tag not in registry; location approximated from the suburb.';
      }
      const open = w.tickets.filter((t) => t.kind === 'FAULT' && !isTerminal(t) && t.group === cat.group && t.grid === sub.grid);
      let match = null, dist = null;
      if (cat.group === 'PREMISES') {
        match = open.find((t) => t.suburb_id === sub.id && norm(t.address_text) === norm(address)) || null;
        dist = match ? 0 : null;
      } else {
        for (const t of open) {
          const d = haversineM(lat, lng, t.lat, t.lng);
          if (d <= 500 && (dist === null || d < dist)) { match = t; dist = d; }
        }
      }
      if (match) {
        match.reports.push({ at, note: details });
        match.updated_at = at;
        addEvent(w, match, actor, match.stage, match.stage, 'Additional report attached (' + Math.round(dist) + ' m from original)', at);
        return { ticket: match, deduplicated: true, distance_m: Math.round(dist), pole_known: poleKnown, note };
      }
      let nearby = null;
      if (cat.group === 'PREMISES') {
        nearby = w.tickets.find((t) => t.kind === 'FAULT' && !isTerminal(t) && t.group === 'AREA' && t.grid === sub.grid && haversineM(lat, lng, t.lat, t.lng) <= 500) || null;
      }
      const t = {
        ticket_id: 'FLT-' + pad(next(w, 'flt', 10000), 5), kind: 'FAULT', group: cat.group, category: input.category,
        priority: cat.priority, grid: sub.grid, suburb_id: sub.id, lat, lng, pole_tag: tag || '', address_text: address,
        details, stage: 'Logged', assigned_crew: '', reports: [{ at, note: details }], created_at: at, updated_at: at, notes: note
      };
      w.tickets.push(t);
      addEvent(w, t, actor, null, 'Logged', 'Ticket created', at);
      if (cat.priority === 'P1') doAdvance(w, t, 'system', 'Auto-verified: P1 hazard', at);
      audit(w, actor, 'FAULT_CREATED', t.ticket_id, cat.priority + ' ' + sub.name);
      return { ticket: t, deduplicated: false, distance_m: null, pole_known: poleKnown, note, nearby_area_outage: nearby ? nearby.ticket_id : null };
    }
    function doCreateTip(w, input, at, fixedCode) {
      if (!TIP_CATS[input.category]) throw E('VALIDATION', 'Choose an offence category.');
      const sub = findSuburb(w, input.suburb_id);
      const t = {
        ticket_id: 'RPU-' + pad(next(w, 'rpu', 10000), 5), kind: 'TIP', group: 'TIP', category: input.category, priority: 'P3',
        grid: sub.grid, suburb_id: sub.id, lat: sub.lat, lng: sub.lng, pole_tag: '',
        address_text: clean(input.address_text, 160, 'Address / landmark', true), details: clean(input.details, 300, 'Details'),
        stage: 'Received', assigned_crew: '', reports: [], created_at: at, updated_at: at, notes: '',
        access_code: fixedCode || randFrom(ALPHA32, 6)
      };
      w.tickets.push(t);
      addEvent(w, t, 'reporter', null, 'Received', 'Tip received', at);
      audit(w, 'reporter', 'TIP_CREATED', t.ticket_id, sub.name);
      return t;
    }

    // ---------- grid simulation ----------
    function localHour(date) { return ((date.getUTCHours() + 10) % 24) + date.getUTCMinutes() / 60; }
    function loadMw(w, key, date) {
      const g = w.grid[key], h = localHour(date), t = date.getTime();
      const shape = 0.7 + 0.3 * Math.exp(-((h - 19) ** 2) / 8) + 0.12 * Math.exp(-((h - 12) ** 2) / 20);
      const noise = 1 + 0.012 * Math.sin(t / 7000) + 0.008 * Math.sin(t / 3100);
      const shed = g.override === 'Feeder Load Shedding' ? 0.85 : 1;
      return Math.round(Math.min(g.capacity_mw, g.base_mw * shape * noise * shed) * 10) / 10;
    }
    function gridStatus(w, key) {
      const g = w.grid[key];
      if (g.override) return { status: g.override, source: 'Control room override' };
      const p1 = w.tickets.filter((t) => t.kind === 'FAULT' && t.priority === 'P1' && t.grid === key && !isTerminal(t)).length;
      if (p1 > 0) return { status: 'Degraded - hazard reports open', source: 'Automatic: ' + p1 + ' open P1 ticket(s)' };
      return { status: 'Normal Operation', source: 'Automatic: no open hazards' };
    }
    function ledFor(m) {
      const days = m.daily_kwh > 0 ? m.balance_kwh / m.daily_kwh : Infinity;
      let state = 'green', label = 'Solid green - sufficient credit';
      if (m.balance_kwh <= 0) { state = 'none'; label = 'No credit - supply cut'; }
      else if (days < 3) { state = 'red'; label = 'Flashing red - about ' + Math.max(1, Math.round(days)) + ' day(s) left'; }
      else if (days <= 7) { state = 'amber'; label = 'Solid amber - about ' + Math.round(days) + ' days left'; }
      return { state, label, days_left: isFinite(days) ? Math.round(days * 10) / 10 : null };
    }

    // ---------- seed ----------
    function seedDb() {
      const t0 = nowFn().getTime();
      const ago = (min) => new Date(t0 - min * MIN).toISOString();
      const now = ago(0);
      const w = {
        meta: { schema: SCHEMA_VERSION, rev: 0, created_at: now, updated_at: now },
        counters: {}, payments: [], vend_transactions: [], tickets: [], ticket_events: [], audit: [], sessions: {}, locks: {}, idem: {},
        brand: { name: 'Demo Utility', tagline: 'Customer & Dispatch Portal', hotline: '0000 0000 (demo)', color: '#0f5f73' },
        config: {
          gst_bp: 1000, show_demo_credentials: true, tz: TZ, channels: CHANNELS, crews: CREWS, offices: OFFICES,
          tariffs: { DOM: { label: 'Domestic (demo rate)', rate_toea: 82 }, COM: { label: 'Commercial (demo rate)', rate_toea: 108 } },
          suburbs: SUBURBS, grids: GRIDS, fault_cats: FAULT_CATS, tip_cats: TIP_CATS, target_min: TARGET_MIN,
          poles: POLE_SEEDS.map(([tag, sid, dx, dy]) => {
            const s = SUBURBS.find((x) => x.id === sid);
            return Object.assign({ tag, suburb: sid }, offsetLatLng(s.lat, s.lng, dx, dy));
          }),
          demo_credentials: {}
        },
        meters: [], postpaid_accounts: [], notices: [],
        grid: {}, staff: []
      };
      Object.keys(GRIDS).forEach((k) => { w.grid[k] = { override: null, base_mw: GRIDS[k].base_mw, capacity_mw: GRIDS[k].capacity_mw }; });
      const mk = (base, holder, tariff, feeder, grid, status, pin, daily, bal) => {
        const num = base + luhnCheckDigit(base);
        w.meters.push({ meter_number: num, holder, tariff, feeder, grid, status, pin_hash: hashSecret(pin, num), daily_kwh: daily, balance_kwh: bal, credited_kwh_total: 0 });
        (w.config.demo_credentials.meters = w.config.demo_credentials.meters || []).push({ meter_number: num, pin, label: holder + (status !== 'ACTIVE' ? ' (blocked)' : '') });
        return num;
      };
      const m1 = mk('0428194021', 'Sample Household A', 'DOM', 'Hohola 11 kV Feeder 04', 'capital', 'ACTIVE', '1234', 9, 0);
      const m2 = mk('0719402883', 'Sample Bakery Ltd', 'COM', 'Boroko 11 kV Commercial', 'capital', 'ACTIVE', '2345', 25, 100);
      mk('0491028374', 'Sample Household B', 'DOM', 'Lae 11 kV Feeder 02', 'highlands', 'ACTIVE', '3456', 9, 6);
      mk('0555123400', 'Sample Blocked Meter', 'DOM', 'Hohola 11 kV Feeder 04', 'capital', 'SUSPENDED', '4567', 9, 0);
      const due = new Date(t0 + 11 * 86400000).toISOString().slice(0, 10);
      const period = new Date(t0 - 30 * 86400000).toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: TZ });
      w.postpaid_accounts.push({
        account: 'ACC-DEMO-0001', holder: 'Sample Commercial Customer Ltd', pin_hash: hashSecret('5678', 'ACC-DEMO-0001'),
        invoices: [{ id: 'INV-' + period.replace(' ', '-').toUpperCase(), period, due_date: due, amount_toea: 48560, paid_toea: 0 }]
      });
      w.config.demo_credentials.account = { account: 'ACC-DEMO-0001', pin: '5678' };
      const staffs = [['dispatcher', 'dispatch123', 'dispatcher'], ['supervisor', 'super123', 'supervisor']];
      staffs.forEach(([user, pw, role]) => w.staff.push({ user, role, hash: hashSecret(pw, 'staff:' + user) }));
      w.config.demo_credentials.staff = staffs.map(([user, password, role]) => ({ user, password, role }));
      // seeded history goes through the same code paths as live traffic
      const seedPay = (meter, amount, ch, min) => {
        const at = ago(min);
        const p = doCreatePayment(w, { kind: 'VEND', meter_number: meter, amount_toea: amount, channel: ch, idempotency_key: 'seed-' + meter + '-' + min }, at);
        doSettle(w, p, at);
      };
      seedPay(m2, 20000, 'bank_ussd', 1500);
      seedPay(m1, 5000, 'wallet', 600);
      const f1 = doCreateFault(w, { category: 'AREA_BLACKOUT', suburb_id: 'waigani', pole_tag: 'POM-A12-04', details: 'Whole street dark since morning' }, ago(150), 'seed').ticket;
      doAdvance(w, f1, 'dispatcher', 'Verified by phone', ago(130));
      doAdvance(w, f1, 'dispatcher', 'Crew en route', ago(100));
      const f2 = doCreateFault(w, { category: 'HAZARD', suburb_id: 'boroko', details: 'Low wire after storm' }, ago(1700), 'seed').ticket;
      ['x', 'x', 'x', 'x'].forEach((_, i) => { if (!isTerminal(f2)) doAdvance(w, f2, 'dispatcher', i === 3 ? 'Repaired' : '', ago(1700 - 30 * (i + 1))); });
      const tip = doCreateTip(w, { category: 'HOOKUP', suburb_id: 'gerehu', address_text: 'Behind the market, near pole POM-G2-09', details: 'Visible direct wire from the pole' }, ago(900), 'DEMO42');
      doAdvance(w, tip, 'supervisor', 'Assigned for review', ago(800));
      w.notices.push(
        { id: 'N1', category: 'Planned Outages', posted_at: ago(300), region: 'Capital Grid', title: 'Planned feeder maintenance: Boroko and Waigani corridors',
          summary: 'Sample notice: switchgear replacement scheduled for tomorrow morning.',
          body: ['This is a SAMPLE notice for the demo. A short interruption is scheduled for parts of Boroko and Waigani tomorrow between 8:00 and 14:00.', 'Treat all powerlines as live at all times, including during maintenance windows.'] },
        { id: 'N2', category: 'Safety & Compliance', posted_at: ago(4000), region: 'All areas', title: 'Stay 10 metres away from fallen powerlines',
          summary: 'Sample safety notice: report hazards immediately and report illegal connections confidentially.',
          body: ['SAMPLE safety notice. Keep at least 10 metres away from any fallen line or sparking transformer and call the hotline immediately.', 'Illegal connections and meter tampering can be reported confidentially through the portal.'] },
        { id: 'N3', category: 'Corporate News', posted_at: ago(9000), region: 'Highlands & Provincial', title: 'Substation relay upgrades and solar-hybrid expansion update',
          summary: 'Sample corporate news item to show how notices appear.', body: ['SAMPLE news item. Replace with real corporate communications.'] }
      );
      audit(w, 'system', 'SEED', 'db', 'Demo database created');
      return w;
    }

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
