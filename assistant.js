(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StepwiseAssistant = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Rules-based assistant. It never calls a language model. Every reply is plain
  // text, so nothing the user types can inject markup into the page.

  const EXTRA_ALIASES = {
    'four-mile': ['4 mile', 'four mile', '4mile'],
    lae: ['top town'],
    madang: ['madang town'],
    hagen: ['mt hagen', 'mount hagen', 'mt hagen town'],
    gordons: ['gordon'],
    kokopo: ['kokopo town']
  };
  const GRID_ALIASES = {
    capital: ['port moresby', 'moresby', 'ncd', 'capital', 'pomis'],
    highlands: ['highlands', 'momase', 'lae', 'madang', 'goroka', 'hagen', 'ramu'],
    islands: ['islands', 'new britain', 'kokopo', 'kimbe', 'gazelle'],
    provincial: ['provincial', 'alotau', 'wewak', 'mini grid', 'mini grids']
  };

  const POLE_RE = /\b[A-Za-z]{3}-[A-Za-z]\d{1,2}-\d{1,3}\b/;
  const METER_RE = /\b\d{11}\b/;
  const TICKET_RE = /\b(FLT|RPU)-\d{4,6}\b/i;
  // Access codes are 6 characters from an unambiguous alphabet. Prefer the code after the word "code".
  function accessCodeFrom(text, ticketId) {
    const rest = String(text).replace(new RegExp(ticketId, 'i'), ' ');
    const after = rest.match(/\bcode\s*(?:is|:|#)?\s*([A-Za-z2-9]{6})\b/i);
    if (after) return after[1].toUpperCase();
    const cands = rest.match(/\b[A-Z2-9]{6}\b/g) || [];
    return cands.length ? cands[0] : '';
  }

  const norm = (s) => ' ' + String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  const rx = (phrase) => new RegExp('(^|\\s)' + phrase.replace(/ /g, '\\s+') + '(s|es)?(?=\\s|$)');
  const has = (text, phrases) => phrases.some((p) => rx(p).test(text));

  const HAZARD = ['fallen wire', 'fallen line', 'fallen power line', 'low wire', 'low line', 'sparking', 'sparks', 'arcing', 'electrocut', 'electric shock', 'got shocked', 'on fire', 'fire at', 'burning transformer', 'exploded', 'explosion', 'transformer fire', 'live wire'];
  const FRAUD = ['illegal connection', 'illegal wire', 'illegal', 'hook up', 'hookup', 'tamper', 'bypass', 'bridged', 'steal', 'stolen power', 'theft', 'free electricity', 'meter fraud'];
  const OUTAGE = ['blackout', 'power is out', 'power out', 'no power', 'no electricity', 'outage', 'lights are off', 'without power', 'power cut'];
  const TOKEN = ['last token', 'missing token', 'lost token', 'my token', 'token not', 'token history', 'token'];
  const GRID = ['grid', 'load', 'power status', 'system status', 'status'];
  const PAY = ['buy', 'pay', 'top up', 'topup', 'vend', 'ussd', 'channel', 'fee', 'fees', 'payment', 'how much', 'card'];
  const OFFICE = ['office', 'centre', 'center', 'where', 'branch', 'hours'];
  const NEWS = ['news', 'notice', 'notices', 'planned', 'maintenance', 'announcement'];
  const SAFETY = ['safety', 'stay away', 'what do i do', 'what should i do', 'help'];
  const NOISE = new Set(['report', 'reporting', 'blackout', 'power', 'out', 'is', 'no', 'there', 'please', 'the', 'a', 'an', 'at', 'near', 'in', 'on', 'pole', 'my', 'our', 'we', 'i', 'have', 'has', 'been', 'since', 'this', 'morning', 'today', 'its', 'it', 'and', 'of']);

  function suburbMatch(api, text) {
    const subs = api.getConfig().suburbs;
    let best = null, bestLen = 0;
    const t = norm(text);
    for (const s of subs) {
      const aliases = [s.name, s.id.replace(/-/g, ' ')].concat(EXTRA_ALIASES[s.id] || []);
      for (const a of aliases) {
        const n = norm(a).trim();
        if (n && t.includes(' ' + n + ' ') && n.length > bestLen) { best = s; bestLen = n.length; }
      }
    }
    return best;
  }
  function gridMatch(text) {
    const t = norm(text);
    for (const k of Object.keys(GRID_ALIASES)) if (GRID_ALIASES[k].some((a) => t.includes(' ' + a + ' '))) return k;
    return null;
  }
  function locationText(text, pole) {
    let s = String(text).replace(new RegExp(POLE_RE.source, 'gi'), ' ');
    s = s.replace(/[^A-Za-z0-9 .'-]+/g, ' ').split(/\s+/).filter((w) => w && !NOISE.has(w.toLowerCase())).join(' ');
    return s.slice(0, 120);
  }
  const key = () => 'ai-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

  function createAssistant(api) {
    let pending = null; // { intent, slots } awaiting a missing detail
    const brand = () => api.getBrand();

    function ticketLines(t) {
      const lines = ['Ticket ' + t.ticket_id + ' - ' + t.stage + (t.priority ? ' (' + t.priority + ')' : '')];
      if (t.kind === 'FAULT') lines.push('Area: ' + t.suburb_name + ' · ' + t.grid_name);
      if (t.kind === 'FAULT' && t.crew) lines.push('Crew: ' + t.crew);
      if (t.kind === 'TIP') lines.push('Confidential report. Staff will review it.');
      return lines;
    }

    function raiseFault(text, category, suburb, extra) {
      const pole = (text.match(POLE_RE) || [''])[0].toUpperCase();
      const loc = locationText(text, pole);
      const r = api.createFault(Object.assign({
        idempotency_key: key(), category, suburb_id: suburb.id, pole_tag: pole, address_text: loc, details: String(text).slice(0, 300)
      }, extra || {}));
      const t = r.ticket;
      const lines = ticketLines(t);
      if (r.deduplicated) lines.unshift('This matches an open report, so I attached your details to it (' + r.distance_m + ' m away).');
      else lines.unshift('I logged a new ticket.');
      if (r.note) lines.push(r.note);
      if (r.nearby_area_outage) lines.push('Note: an area outage ' + r.nearby_area_outage + ' is open nearby.');
      return { text: lines[0], lines: lines.slice(1), tool: 'create_fault_ticket', actions: [{ label: 'Track ticket', nav: 'tracker' }] };
    }

    function hazard(text, suburb) {
      const brandNow = brand();
      const intro = ['Stay at least 10 metres away from fallen or sparking lines.', 'Call ' + brandNow.hotline + ' now.', 'Quote the nearest pole tag if you can see one.'];
      if (!suburb) {
        pending = { intent: 'hazard', text };
        return { text: 'This sounds like an electrical hazard.', lines: intro.concat(['Which suburb or town is it in? I will log it straight away.']), tool: 'emergency_safety_override', actions: [] };
      }
      const r = raiseFault(text, 'HAZARD', suburb);
      return { text: 'This sounds like an electrical hazard. I have logged it as priority P1.', lines: intro.concat(r.lines), tool: 'emergency_safety_override + create_fault_ticket', actions: r.actions };
    }

    function outage(text, suburb) {
      if (!suburb) {
        pending = { intent: 'outage', text };
        return { text: 'I can log that outage. Which suburb or town is it in?', lines: ['Include a pole tag like POM-A12-04 if you can see one.'], tool: null, actions: [] };
      }
      const r = raiseFault(text, 'AREA_BLACKOUT', suburb);
      return { text: r.text, lines: r.lines, tool: 'create_fault_ticket', actions: r.actions };
    }

    function tokenHelp(text) {
      const m = text.match(METER_RE);
      if (!m) {
        pending = { intent: 'token' };
        return { text: 'Which 11-digit meter number is it for?', lines: [], tool: null, actions: [] };
      }
      try { api.lookupMeter(m[0]); } catch (e) {
        return { text: e.message, lines: [], tool: null, actions: [] };
      }
      return {
        text: 'For privacy, I do not show tokens in chat. Unlock the meter with its PIN in EasiPay to see its token history.',
        lines: ['If your payment went through but no token arrived, check the payment status in EasiPay first.'],
        tool: null, actions: [{ label: 'Open EasiPay', nav: 'easipay' }]
      };
    }

    function gridReply(text) {
      const g = gridMatch(text);
      const grids = api.getGrid();
      const pick = g ? grids.filter((x) => x.key === g) : grids;
      return {
        text: 'Current grid status:', tool: 'query_grid_telemetry', actions: [{ label: 'Open grid view', nav: 'grid' }],
        lines: pick.map((x) => x.name + ': ' + x.status + ' (' + x.load_mw + ' MW of ' + x.capacity_mw + ' MW)' + (x.open_p1 ? ' · ' + x.open_p1 + ' P1 open' : ''))
      };
    }

    function trackReply(text) {
      const id = text.match(TICKET_RE)[0].toUpperCase();
      try {
        const t = api.trackTicket({ ticket_id: id, access_code: accessCodeFrom(text, id) });
        return { text: ticketLines(t)[0], lines: ticketLines(t).slice(1).concat(['Latest update: ' + (t.timeline.length ? t.timeline[t.timeline.length - 1].stage : t.stage)]), tool: 'track_ticket', actions: [] };
      } catch (e) {
        if (id.startsWith('RPU')) return { text: 'Confidential tip-offs need their access code. Enter the code you were given with the ticket number.', lines: [], tool: null, actions: [] };
        return { text: 'I could not find that ticket. Check the number and try again.', lines: [], tool: null, actions: [] };
      }
    }

    function payReply() {
      const cfg = api.getConfig();
      return {
        text: 'Ways to buy a token in EasiPay (fees and limits from the demo settings):', tool: 'get_payment_channels', actions: [{ label: 'Open EasiPay', nav: 'easipay' }],
        lines: cfg.channels.map((c) => c.label + ': min K' + (c.min_toea / 100).toFixed(2) + ', max K' + (c.max_toea / 100).toFixed(2) + (c.fee_toea ? ', fee K' + (c.fee_toea / 100).toFixed(2) : '') + (c.fee_pct ? ', fee ' + (c.fee_pct * 100).toFixed(1) + '%' : ''))
          .concat(['Tokens are issued immediately after the payment is confirmed.'])
      };
    }

    function officeReply(text) {
      const offices = api.listOffices();
      const sub = suburbMatch(api, text);
      const t = norm(text);
      const picks = offices.filter((o) => (sub && norm(o.town).includes(' ' + sub.id.replace(/-/g, ' ') + ' ')) || (!sub && t.includes(' ' + o.region.toLowerCase().split(' ')[0] + ' ')));
      return { text: picks.length ? 'Customer service centres:' : 'Here are all customer service centres:', lines: (picks.length ? picks : offices).map((o) => o.name + ' - ' + o.town + ' (' + o.hours + ')'), tool: 'find_office', actions: [{ label: 'Open office finder', nav: 'offices' }] };
    }

    function newsReply() {
      const n = api.listNotices().slice(0, 3);
      return { text: 'Latest notices:', lines: n.map((x) => x.title + ' (' + x.category + ')'), tool: 'list_notices', actions: [{ label: 'Open news', nav: 'news' }] };
    }

    function safetyReply() {
      return {
        text: 'Safety basics:', tool: null, actions: [{ label: 'Open safety page', nav: 'safety' }],
        lines: ['Stay at least 10 metres from fallen lines or sparking transformers.', 'Never touch a line or a person in contact with one. Call ' + brand().hotline + '.', 'Report a blackout with the suburb and pole tag so crews find it faster.']
      };
    }

    function fraudReply() {
      return {
        text: 'Illegal connections and meter tampering can be reported confidentially. I will not take the details in chat.', tool: null,
        lines: ['Open the Fraud tab. It gives you a confidential access code to track the report later.'],
        actions: [{ label: 'Open Fraud tab', nav: 'fraud' }]
      };
    }

    function fallback() {
      return {
        text: 'I can help with these. Try one of these:', tool: null, actions: [],
        lines: ['"Report blackout at Waigani pole POM-A12-04"', '"Fallen wire in Boroko, call urgently"', '"Status of FLT-10001"', '"Grid status in Port Moresby"', '"How do I buy a token?"', '"Which office is in Lae?"']
      };
    }

    function continuePending(text) {
      const p = pending;
      if (!p) return null;
      const sub = suburbMatch(api, text);
      if (p.intent === 'token') {
        pending = null; return tokenHelp(text);
      }
      if (!sub) return { text: 'I still need the suburb or town. For example, "Boroko" or "Lae".', lines: [], tool: null, actions: [] };
      pending = null;
      const full = p.text + ' ' + text;
      return p.intent === 'hazard' ? hazard(full, sub) : outage(full, sub);
    }

    function respond(input) {
      const text = String(input || '').slice(0, 500).trim();
      if (!text) return { text: 'Type a question or request and I will try to help.', lines: [], tool: null, actions: [] };
      const cont = continuePending(text);
      if (cont) return cont;
      const t = norm(text);
      if (TICKET_RE.test(text) && has(t, ['status', 'track', 'where', 'update', 'check', 'ticket'])) return trackReply(text);
      if (TICKET_RE.test(text)) return trackReply(text);
      if (has(t, HAZARD)) return hazard(text, suburbMatch(api, text));
      if (has(t, FRAUD)) return fraudReply();
      if (has(t, OUTAGE) || POLE_RE.test(text)) return outage(text, suburbMatch(api, text));
      if (has(t, TOKEN) || METER_RE.test(text)) return tokenHelp(text);
      if (has(t, GRID) && !has(t, PAY)) return gridReply(text);
      if (has(t, PAY)) return payReply();
      if (has(t, OFFICE)) return officeReply(text);
      if (has(t, NEWS)) return newsReply();
      if (has(t, SAFETY)) return safetyReply();
      return fallback();
    }

    return { respond, _pending: () => pending, _reset: () => { pending = null; } };
  }

  return { createAssistant, suburbMatch, gridMatch, locationText, POLE_RE, METER_RE, TICKET_RE };
});
