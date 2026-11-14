
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
        brand: { name: 'Stepwise Ventures', tagline: 'Utility Customer & Dispatch Portal', hotline: '0000 0000 (demo)', color: '#1f2430' },
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
      w.config.demo_credentials.fault = { ticket_id: f1.ticket_id, note: 'Open area blackout in Waigani' };
      w.config.demo_credentials.tip = { ticket_id: tip.ticket_id, access_code: tip.access_code, note: 'Confidential tip-off in Gerehu' };
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
