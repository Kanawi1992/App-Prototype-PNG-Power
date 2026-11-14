'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Eng = require('../engine.js');
const A = require('../src/assistant.js');

class FakeLS { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); } removeItem(k) { this.m.delete(k); } }
function setup() {
  const api = Eng.create({ storage: new FakeLS(), now: () => new Date('2026-11-14T01:40:00Z') });
  return { api, bot: A.createAssistant(api) };
}
const all = (r) => [r.text].concat(r.lines || []).join('\n');

test('fallen wire logs a P1 hazard ticket and gives safety advice', () => {
  const { api, bot } = setup();
  const before = api.getStats().open_p1;
  const r = bot.respond('fallen wire in Boroko near the market');
  assert.match(r.tool, /create_fault_ticket/);
  assert.match(all(r), /10 metres/);
  assert.match(all(r), /P1/);
  assert.equal(api.getStats().open_p1, before + 1);
});

test('illegal wire is routed to fraud, not the hazard branch', () => {
  const { api, bot } = setup();
  const before = api.getStats().open_p1;
  const r = bot.respond('someone has an illegal wire to their house in Hohola');
  assert.match(r.text, /confidential/i);
  assert.ok(r.actions.some((a) => a.nav === 'fraud'));
  assert.equal(api.getStats().open_p1, before);
});

test('hazard without a suburb asks for it and then logs', () => {
  const { api, bot } = setup();
  const first = bot.respond('sparking transformer');
  assert.match(all(first), /Which suburb/);
  assert.equal(first.tool, 'emergency_safety_override');
  const second = bot.respond('Waigani');
  assert.match(all(second), /Ticket P|FLT-/);
  assert.equal(bot._pending(), null);
});

test('outage report extracts pole tag and suburb, and stores the pole location', () => {
  const { api, bot } = setup();
  const r = bot.respond('Report blackout at Waigani pole POM-A12-04');
  assert.equal(r.tool, 'create_fault_ticket');
  // Seed data already has an open area blackout at POM-A12-04 in Waigani, so this should deduplicate onto it
  assert.match(all(r), /matches an open report/);
  const s = api.login('dispatcher', 'dispatch123');
  const open = api.staffTickets(s.token, { kind: 'FAULT' }).filter((t) => t.pole_tag === 'POM-A12-04');
  assert.ok(open.length >= 1);
  assert.ok(open.every((t) => t.suburb_id === 'waigani'));
});

test('location text keeps words like "Waterfront" intact', () => {
  assert.equal(A.locationText('Blackout at Waterfront Road pole POM-A12-09', 'POM-A12-09'), 'Waterfront Road');
});

test('outage with no suburb asks which suburb', () => {
  const { bot } = setup();
  const r = bot.respond('there is no power here');
  assert.match(r.text, /Which suburb/);
});

test('"4-Mile" and "four mile" both resolve to 4-Mile', () => {
  assert.equal(A.suburbMatch(setup().api, 'outage in 4-Mile').id, 'four-mile');
  assert.equal(A.suburbMatch(setup().api, 'outage in four mile').id, 'four-mile');
});

test('token request never reveals a token and asks for a meter number first', () => {
  const { api, bot } = setup();
  const r0 = bot.respond('what is my last token');
  assert.match(r0.text, /11-digit meter/);
  const c = api.demoCredentials().meters[0].meter_number;
  const r1 = bot.respond('last token for ' + c);
  assert.match(all(r1), /For privacy/);
  assert.ok(!/\d{4}-\d{4}-/.test(all(r1)));
  assert.equal(bot.respond('token for 04281940210').tool, null);
});

test('ticket status for public FLT ticket works; RPU needs its access code', () => {
  const { api, bot } = setup();
  const id = api.searchFaults({})[0].ticket_id;
  assert.match(bot.respond('status of ' + id).text, new RegExp(id));
  const tip = api.createTip({ idempotency_key: 'tip-key-123', category: 'HOOKUP', suburb_id: 'lae', address_text: 'Test St', details: 'x' });
  assert.match(bot.respond('status of ' + tip.ticket_id).text, /access code/);
  assert.match(bot.respond('status of ' + tip.ticket_id + ' code ' + tip.access_code).text, new RegExp(tip.ticket_id));
});

test('grid query uses word boundaries and reports a single grid', () => {
  const { bot } = setup();
  const r = bot.respond('grid status in Port Moresby');
  assert.equal(r.lines.length, 1); assert.match(r.lines[0], /Capital Grid/);
  assert.equal(bot.respond('status of the grid').lines.length, 4);
});

test('payment question lists real channels with limits and fees', () => {
  const { bot } = setup();
  const r = bot.respond('how do I pay by USSD');
  assert.ok(r.lines.some((l) => /Telco airtime billing/.test(l) && /min K15\.00/.test(l)));
});

test('office finder filters by town', () => {
  const { bot } = setup();
  const r = bot.respond('which office is in Lae');
  assert.equal(r.lines.length, 1); assert.match(r.lines[0], /Lae/);
});

test('unknown input falls back to a helpful list and never throws', () => {
  const { bot } = setup();
  assert.match(bot.respond('xyzzy').text, /I can help/);
  assert.doesNotThrow(() => bot.respond('<img src=x onerror=alert(1)>'));
  assert.equal(bot.respond('').tool, null);
});
