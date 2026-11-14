'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const Eng = require('../engine.js');

class FakeLS { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); } removeItem(k) { this.m.delete(k); } }
function mk(opts) {
  const clock = { t: Date.parse('2026-11-14T01:40:00Z') };
  const ls = (opts && opts.ls) || new FakeLS();
  const api = Eng.create({ storage: ls, now: () => new Date(clock.t) });
  return { api, clock, ls };
}
const key = () => nodeCrypto.randomBytes(8).toString('hex');
const rejects = (fn, code) => assert.throws(fn, (e) => e.code === code, 'expected ' + code);
function creds(api) { const c = api.demoCredentials(); return { m1: c.meters[0], m2: c.meters[1], m3: c.meters[2], m4: c.meters[3], acc: c.account }; }

test('sha256 matches node crypto', () => {
  for (const s of ['', 'abc', 'staff:supervisor', 'x'.repeat(200), 'café']) {
    assert.equal(Eng.sha256(s), nodeCrypto.createHash('sha256').update(s, 'utf8').digest('hex'));
  }
});
test('luhn helpers', () => {
  assert.ok(Eng.luhnValid('79927398713'));
  const b = '0428194021'; assert.ok(Eng.luhnValid(b + Eng.luhnCheckDigit(b)));
  assert.ok(!Eng.luhnValid('79927398710'));
});
test('seeded meters have valid check digits and masked lookup', () => {
  const { api } = mk(); const c = creds(api);
  assert.ok(Eng.luhnValid(c.m1.meter_number));
  const l = api.lookupMeter(c.m1.meter_number);
  assert.match(l.holder_masked, /^S\*\*\* H\*\*\* A\*\*\*$/);
  rejects(() => api.lookupMeter('1234'), 'METER_FORMAT');
  rejects(() => api.lookupMeter(c.m1.meter_number.slice(0, 10) + ((+c.m1.meter_number[10] + 1) % 10)), 'METER_CHECKSUM');
  rejects(() => api.lookupMeter(c.m4.meter_number), 'METER_BLOCKED');
});
test('LED states come from real meter balances', () => {
  const { api } = mk(); const c = creds(api);
  assert.equal(api.lookupMeter(c.m1.meter_number).led.state, 'amber');
  assert.equal(api.lookupMeter(c.m2.meter_number).led.state, 'green');
  assert.equal(api.lookupMeter(c.m3.meter_number).led.state, 'red');
});
test('quote: GST inclusive, energy + gst = amount, channel limits', () => {
  const { api } = mk(); const c = creds(api);
  const q = api.quote({ meter_number: c.m1.meter_number, amount_toea: 5000, channel: 'bank_ussd' });
  assert.equal(q.gst_toea, 455); assert.equal(q.energy_toea + q.gst_toea, 5000); assert.equal(q.fee_toea, 50); assert.equal(q.total_toea, 5050);
  assert.equal(q.kwh, Math.floor(q.energy_toea * 100 / 82) / 100);
  assert.equal(api.quote({ meter_number: c.m1.meter_number, amount_toea: 10000, channel: 'card' }).fee_toea, 150);
  rejects(() => api.quote({ meter_number: c.m1.meter_number, amount_toea: 1000, channel: 'telco' }), 'AMOUNT_LIMIT');
  rejects(() => api.quote({ meter_number: c.m1.meter_number, amount_toea: 6000, channel: 'telco' }), 'AMOUNT_LIMIT');
  rejects(() => api.quote({ meter_number: c.m1.meter_number, amount_toea: 12.5, channel: 'wallet' }), 'AMOUNT_INVALID');
});
test('vend: idempotent create, token issued once, balance credited once', () => {
  const { api } = mk(); const c = creds(api); const k = key();
  const inp = { kind: 'VEND', meter_number: c.m3.meter_number, amount_toea: 5000, channel: 'wallet', idempotency_key: k };
  const p1 = api.createPayment(inp), p2 = api.createPayment(inp);
  assert.equal(p1.id, p2.id);
  rejects(() => api.createPayment(Object.assign({}, inp, { amount_toea: 6000 })), 'IDEM_MISMATCH');
  const r1 = api.gatewayRespond(p1.id, 'approve'), r2 = api.gatewayRespond(p1.id, 'approve');
  assert.match(r1.tx.token, /^\d{4}(-\d{4}){4}$/);
  assert.equal(r1.tx.token, r2.tx.token);
  const led = api.lookupMeter(c.m3.meter_number).led;
  assert.notEqual(led.state, 'red');
  const auth = api.verifyMeter(c.m3.meter_number, c.m3.pin);
  assert.equal(api.listVendHistory({ meter_number: c.m3.meter_number, auth_token: auth.auth_token }).transactions.length, 1);
});
test('decline gives no token; noresponse stays pending; reconcile settles; expiry blocks', () => {
  const { api, clock } = mk(); const c = creds(api);
  const base = { kind: 'VEND', meter_number: c.m1.meter_number, amount_toea: 2000, channel: 'wallet' };
  const a = api.createPayment(Object.assign({ idempotency_key: key() }, base));
  const ra = api.gatewayRespond(a.id, 'decline');
  assert.equal(ra.payment.status, 'FAILED'); assert.equal(ra.tx, null);
  rejects(() => api.gatewayRespond(a.id, 'approve'), 'INVALID_STATE');
  const b = api.createPayment(Object.assign({ idempotency_key: key() }, base));
  assert.equal(api.gatewayRespond(b.id, 'noresponse').payment.status, 'PENDING');
  const rb = api.reconcilePayment(b.id); assert.equal(rb.payment.status, 'SETTLED'); assert.ok(rb.tx.token);
  const d = api.createPayment(Object.assign({ idempotency_key: key() }, base));
  clock.t += 16 * 60000;
  assert.equal(api.getPayment(d.id).status, 'EXPIRED');
  rejects(() => api.gatewayRespond(d.id, 'approve'), 'INVALID_STATE');
});
test('tokens are unique across many vends', () => {
  const { api } = mk(); const c = creds(api); const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const p = api.createPayment({ kind: 'VEND', meter_number: c.m2.meter_number, amount_toea: 1000 + i, channel: 'wallet', idempotency_key: key() });
    const t = api.gatewayRespond(p.id, 'approve').tx.token; assert.ok(!seen.has(t)); seen.add(t);
  }
});
test('PIN lockout after 5 failures, then recovers after 10 minutes', () => {
  const { api, clock } = mk(); const c = creds(api);
  for (let i = 0; i < 5; i++) rejects(() => api.verifyMeter(c.m1.meter_number, '0000'), 'BAD_CREDENTIALS');
  rejects(() => api.verifyMeter(c.m1.meter_number, c.m1.pin), 'LOCKED');
  clock.t += 11 * 60000;
  assert.ok(api.verifyMeter(c.m1.meter_number, c.m1.pin).auth_token);
});
test('token history needs auth', () => {
  const { api } = mk(); const c = creds(api);
  rejects(() => api.listVendHistory({ meter_number: c.m1.meter_number }), 'AUTH_REQUIRED');
  const other = api.verifyMeter(c.m2.meter_number, c.m2.pin);
  rejects(() => api.listVendHistory({ meter_number: c.m1.meter_number, auth_token: other.auth_token }), 'AUTH_REQUIRED');
  const s = api.login('dispatcher', 'dispatch123');
  assert.ok(api.listVendHistory({ meter_number: c.m1.meter_number, auth_token: s.token }).transactions.length >= 1);
});
test('postpaid: needs unlock, partial pay, overpay rejected, full pay clears', () => {
  const { api } = mk(); const c = creds(api);
  const base = { kind: 'POSTPAID', account: c.acc.account, channel: 'wallet' };
  rejects(() => api.createPayment(Object.assign({ idempotency_key: key(), amount_toea: 1000 }, base)), 'AUTH_REQUIRED');
  const au = api.verifyAccount(c.acc.account, c.acc.pin).auth_token;
  assert.equal(api.getStatement({ account: c.acc.account, auth_token: au }).total_due_toea, 48560);
  rejects(() => api.createPayment(Object.assign({ idempotency_key: key(), amount_toea: 50000, auth_token: au }, base)), 'OVERPAY');
  let p = api.createPayment(Object.assign({ idempotency_key: key(), amount_toea: 10000, auth_token: au }, base));
  api.gatewayRespond(p.id, 'approve');
  assert.equal(api.getStatement({ account: c.acc.account, auth_token: au }).total_due_toea, 38560);
  p = api.createPayment(Object.assign({ idempotency_key: key(), amount_toea: 38560, auth_token: au }, base));
  api.gatewayRespond(p.id, 'approve');
  assert.equal(api.getStatement({ account: c.acc.account, auth_token: au }).total_due_toea, 0);
  rejects(() => api.createPayment(Object.assign({ idempotency_key: key(), amount_toea: 100, auth_token: au }, base)), 'NOTHING_DUE');
});
test('faults: P1 auto-verify, 500 m dedup, far pole not merged, premises dedup by address', () => {
  const { api } = mk();
  const f = (o) => api.createFault(Object.assign({ idempotency_key: key(), category: 'AREA_BLACKOUT', suburb_id: 'waigani' }, o));
  const a = f({ pole_tag: 'POM-A12-05', details: 'x' });   // existing seed ticket is at POM-A12-04 (~224 m away)
  assert.equal(a.deduplicated, true); assert.ok(a.distance_m > 200 && a.distance_m < 260);
  const b = f({ pole_tag: 'POM-A12-40' });                  // ~900 m away
  assert.equal(b.deduplicated, false);
  const h = api.createFault({ idempotency_key: key(), category: 'HAZARD', suburb_id: 'hohola' });
  assert.equal(h.ticket.priority, 'P1'); assert.equal(h.ticket.stage, 'Verified');
  const p1 = api.createFault({ idempotency_key: key(), category: 'SINGLE_PREMISES', suburb_id: 'gerehu', address_text: 'Lot 5 Sec 2' });
  const p2 = api.createFault({ idempotency_key: key(), category: 'SINGLE_PREMISES', suburb_id: 'gerehu', address_text: 'lot 5  sec 2' });
  const p3 = api.createFault({ idempotency_key: key(), category: 'SINGLE_PREMISES', suburb_id: 'gerehu', address_text: 'Lot 9 Sec 2' });
  assert.equal(p2.deduplicated, true); assert.equal(p3.deduplicated, false);
  rejects(() => api.createFault({ idempotency_key: key(), category: 'AREA_BLACKOUT', suburb_id: 'nowhere' }), 'VALIDATION');
  rejects(() => api.createFault({ idempotency_key: key(), category: 'AREA_BLACKOUT', suburb_id: 'waigani', pole_tag: 'bad tag' }), 'VALIDATION');
  rejects(() => api.createFault({ idempotency_key: key(), category: 'SINGLE_PREMISES', suburb_id: 'gerehu' }), 'VALIDATION');
  const k = key(); const r1 = f({ pole_tag: 'POM-A12-40' }); void r1;
  const x1 = api.createFault({ idempotency_key: k, category: 'POLE', suburb_id: 'boroko' }), x2 = api.createFault({ idempotency_key: k, category: 'POLE', suburb_id: 'boroko' });
  assert.equal(x1.ticket.ticket_id, x2.ticket.ticket_id);
});
test('tips are private: need code, no location, not in public search', () => {
  const { api } = mk();
  const r = api.createTip({ idempotency_key: key(), category: 'BYPASS', suburb_id: 'lae', address_text: 'Lot 1 Test St', details: 'secret' });
  rejects(() => api.trackTicket({ ticket_id: r.ticket_id }), 'NOT_FOUND');
  rejects(() => api.trackTicket({ ticket_id: r.ticket_id, access_code: 'WRONG1' }), 'NOT_FOUND');
  const v = api.trackTicket({ ticket_id: r.ticket_id, access_code: r.access_code.toLowerCase() });
  assert.equal(v.stage, 'Received'); assert.ok(!('address_text' in v) && !('details' in v));
  assert.ok(api.searchFaults({}).every((t) => t.kind === 'FAULT'));
  assert.ok(!JSON.stringify(api.searchFaults({})).includes('Lot 1 Test St'));
});
test('staff: auth, roles, stage machine, crews, cancel', () => {
  const { api } = mk();
  rejects(() => api.staffTickets('nope'), 'AUTH_REQUIRED');
  rejects(() => api.login('dispatcher', 'bad'), 'BAD_CREDENTIALS');
  const d = api.login('dispatcher', 'dispatch123');
  rejects(() => api.setGridOverride(d.token, 'capital', 'Feeder Load Shedding'), 'FORBIDDEN');
  rejects(() => api.auditLog(d.token), 'FORBIDDEN');
  const t = api.createFault({ idempotency_key: key(), category: 'AREA_BLACKOUT', suburb_id: 'lae' }).ticket;
  let v = api.advanceTicket(d.token, t.ticket_id, 'ok'); assert.equal(v.stage, 'Verified');
  v = api.advanceTicket(d.token, t.ticket_id); assert.equal(v.stage, 'Crew Dispatched'); assert.match(v.assigned_crew, /Highlands/);
  api.advanceTicket(d.token, t.ticket_id); v = api.advanceTicket(d.token, t.ticket_id);
  assert.equal(v.stage, 'Resolved');
  rejects(() => api.advanceTicket(d.token, t.ticket_id), 'INVALID_TRANSITION');
  rejects(() => api.cancelTicket(d.token, t.ticket_id, 'duplicate'), 'INVALID_TRANSITION');
  const t2 = api.createFault({ idempotency_key: key(), category: 'POLE', suburb_id: 'kokopo' }).ticket;
  rejects(() => api.cancelTicket(d.token, t2.ticket_id, ''), 'VALIDATION');
  assert.equal(api.cancelTicket(d.token, t2.ticket_id, 'false alarm').stage, 'Cancelled');
});
test('staff session expires after 30 minutes', () => {
  const { api, clock } = mk(); const s = api.login('dispatcher', 'dispatch123');
  assert.ok(api.whoami(s.token)); clock.t += 31 * 60000;
  rejects(() => api.whoami(s.token), 'AUTH_REQUIRED');
});
test('grid status is derived from tickets, override wins, load is bounded', () => {
  const { api } = mk();
  assert.equal(api.getGrid().find((g) => g.key === 'islands').status, 'Normal Operation');
  api.createFault({ idempotency_key: key(), category: 'HAZARD', suburb_id: 'kokopo' });
  assert.match(api.getGrid().find((g) => g.key === 'islands').status, /Degraded/);
  const s = api.login('supervisor', 'super123');
  api.setGridOverride(s.token, 'islands', 'Feeder Load Shedding');
  assert.equal(api.getGrid().find((g) => g.key === 'islands').status, 'Feeder Load Shedding');
  api.setGridOverride(s.token, 'islands', null);
  assert.match(api.getGrid().find((g) => g.key === 'islands').status, /Degraded/);
  api.getGrid().forEach((g) => assert.ok(g.load_mw > 0 && g.load_mw <= g.capacity_mw));
});
test('finance reconciliation is clean after real flows and detects tampering', () => {
  const { api, ls } = mk(); const c = creds(api);
  const p = api.createPayment({ kind: 'VEND', meter_number: c.m2.meter_number, amount_toea: 9999, channel: 'card', idempotency_key: key() });
  api.gatewayRespond(p.id, 'approve');
  const s = api.login('supervisor', 'super123');
  assert.deepEqual(api.financeReport(s.token).anomalies, []);
  const raw = JSON.parse(ls.getItem(Eng.DB_KEY)); raw.vend_transactions[0].gst_toea += 7; raw.meters[0].credited_kwh_total += 3;
  ls.setItem(Eng.DB_KEY, JSON.stringify(raw)); api.reload();
  const an = api.financeReport(s.token).anomalies;
  assert.ok(an.some((x) => /energy \+ GST/.test(x)) && an.some((x) => /credited kWh/.test(x)));
});
test('persistence, corrupt-storage recovery, and two-tab consistency', () => {
  const a = mk(); const c = creds(a.api);
  const p = a.api.createPayment({ kind: 'VEND', meter_number: c.m1.meter_number, amount_toea: 2000, channel: 'wallet', idempotency_key: key() });
  const b = Eng.create({ storage: a.ls, now: () => new Date(a.clock.t) });
  assert.equal(b.getPayment(p.id).status, 'PENDING');
  const q = b.createPayment({ kind: 'VEND', meter_number: c.m1.meter_number, amount_toea: 3000, channel: 'wallet', idempotency_key: key() });
  assert.equal(a.api.getPayment(q.id).status, 'PENDING'); assert.equal(a.api.getPayment(p.id).status, 'PENDING');
  a.ls.setItem(Eng.DB_KEY, '{not json');
  const r = Eng.create({ storage: a.ls, now: () => new Date(a.clock.t) });
  assert.ok(r.demoCredentials()); assert.equal(a.ls.getItem(Eng.DB_KEY + '_corrupt'), '{not json');
});
test('failed operations roll back completely', () => {
  const { api } = mk(); const before = api.health().rev;
  try { api.createPayment({ kind: 'VEND', meter_number: '00000000000', amount_toea: 2000, channel: 'wallet', idempotency_key: key() }); } catch (e) { /* expected */ }
  assert.equal(api.health().rev, before);
});
test('storage unavailable falls back to memory; full storage rolls back with a clear error', () => {
  const mem = Eng.create({ storage: null }); assert.equal(mem.health().persistent, false);
  const ls = new FakeLS(); const { api } = mk({ ls }); const c = creds(api);
  const orig = ls.setItem.bind(ls); ls.setItem = () => { throw new Error('QuotaExceededError'); };
  rejects(() => api.createPayment({ kind: 'VEND', meter_number: c.m1.meter_number, amount_toea: 2000, channel: 'wallet', idempotency_key: key() }), 'STORAGE_FULL');
  ls.setItem = orig;
  assert.equal(api.getStats().tokens, 2);
});
test('reset demo requires supervisor and keeps the session', () => {
  const { api } = mk(); const c = creds(api);
  const d = api.login('dispatcher', 'dispatch123'); rejects(() => api.resetDemo(d.token), 'FORBIDDEN');
  const p = api.createPayment({ kind: 'VEND', meter_number: c.m3.meter_number, amount_toea: 2000, channel: 'wallet', idempotency_key: key() });
  api.gatewayRespond(p.id, 'approve');
  const s = api.login('supervisor', 'super123'); api.resetDemo(s.token);
  assert.equal(api.getStats().tokens, 2); assert.equal(api.whoami(s.token).role, 'supervisor');
});
test('export hides secrets', () => {
  const { api } = mk(); const s = api.login('supervisor', 'super123');
  const x = api.exportDb(s.token); assert.ok(!/pin_hash":\s*"[0-9a-f]{64}/.test(x)); assert.ok(!x.includes('super123'));
});
