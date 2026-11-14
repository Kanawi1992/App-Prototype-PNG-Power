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
