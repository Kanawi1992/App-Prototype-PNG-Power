(function () {
  'use strict';
  const U = window.StepwiseUI;
  const { api, bot, h, money, fmtTime, newKey, toast, fail, errMsg, go, table, kvs, field, select, pill, openModal } = U;

  function statusClass(s) {
    if (/Normal/i.test(s)) return 'ok';
    if (/Degraded|Scheduled/i.test(s)) return 'warn';
    return 'bad';
  }

  // ---------- GRID ----------
  U.views.grid = {
    render(root) {
      const box = h('div', { class: 'grid', 'aria-live': 'polite' });
      const note = h('p', { class: 'muted' }, 'Sample figures for the demo. Load values are simulated from the time of day and any open hazards. Status updates automatically.');
      function draw() {
        const grids = api.getGrid();
        box.replaceChildren(...grids.map((g) => {
          const pct = Math.min(100, Math.round(g.load_mw / g.capacity_mw * 100));
          return h('div', { class: 'card' },
            h('div', { class: 'row', style: 'justify-content:space-between' }, h('strong', null, g.name), pill(g.status, statusClass(g.status))),
            h('p', { class: 'muted', style: 'margin:4px 0 8px' }, g.source),
            h('div', { class: 'progress ' + (pct > 90 ? 'bad' : pct > 75 ? 'warn' : '') , role: 'img', 'aria-label': 'Load ' + pct + ' percent' }, h('i', { style: 'width:' + pct + '%' })),
            h('p', { class: 'muted' }, g.load_mw + ' MW of ' + g.capacity_mw + ' MW · ' + g.open_faults + ' open fault(s)' + (g.open_p1 ? ' · ' + g.open_p1 + ' P1' : '')),
            h('p', null, g.overview),
            h('p', { class: 'muted' }, 'Specs: ' + g.specs),
            h('ul', { style: 'margin:0;padding-left:18px' }, g.mix.map((m) => h('li', null, m.label + ': ' + m.pct + '%'))));
        }));
      }
      root.append(h('h1', null, 'Grid status'), h('p', { class: 'sub' }, 'Live status of the regional grids, from the simulated control room.'), note, box);
      draw();
      U.setLive(draw);
    }
  };

  // ---------- NEWS ----------
  U.views.news = {
    render(root) {
      const all = api.listNotices();
      const cats = [['all', 'All categories']].concat([...new Set(all.map((n) => n.category))].map((c) => [c, c]));
      const cat = select(cats, 'all');
      const list = h('div', { class: 'grid' });
      function draw() {
        const rows = all.filter((n) => cat.value === 'all' || n.category === cat.value);
        list.replaceChildren(h('div', { style: 'display:contents' }, rows.length ? rows.map((n) => h('div', { class: 'card' },
          h('div', { class: 'muted' }, n.category + ' · ' + n.region + ' · ' + fmtTime(n.posted_at)),
          h('strong', null, n.title),
          h('p', { class: 'muted' }, n.summary),
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => openNotice(n) }, 'Read notice'))) : h('p', { class: 'muted' }, 'No notices in this category.')));
      }
      cat.addEventListener('change', draw);
      root.append(h('h1', null, 'News & public notices'), h('p', { class: 'sub' }, 'Planned outages, safety messages and company news.'),
        h('div', { class: 'row', style: 'margin-bottom:12px' }, field('Category', cat)), list);
      draw();
    }
  };
  function openNotice(n) {
    const close = openModal(h('div', { class: 'card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'nt' },
      h('div', { class: 'muted' }, n.category + ' · ' + n.region + ' · ' + fmtTime(n.posted_at)),
      h('h2', { id: 'nt' }, n.title),
      n.body.map((p) => h('p', null, p)),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(n.title + '\n\n' + n.body.join('\n\n')).then(() => toast('Notice copied.'), () => toast('Copy not available here.')); } }, 'Copy text'),
        h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Close'))));
  }

  // ---------- OFFICES ----------
  U.views.offices = {
    render(root) {
      const offices = api.listOffices();
      const regions = [['all', 'All regions']].concat([...new Set(offices.map((o) => o.region))].map((r) => [r, r]));
      const reg = select(regions, 'all');
      const q = h('input', { placeholder: 'Search town or office', 'aria-label': 'Search offices' });
      const list = h('div', { class: 'grid' });
      function draw() {
        const s = q.value.trim().toLowerCase();
        const rows = offices.filter((o) => (reg.value === 'all' || o.region === reg.value) && (!s || (o.name + ' ' + o.town).toLowerCase().includes(s)));
        list.replaceChildren(h('div', { style: 'display:contents' }, rows.length ? rows.map((o) => h('div', { class: 'card' },
          h('strong', null, o.name), h('p', { class: 'muted' }, o.town + ' · ' + o.region),
          h('p', null, o.address), h('p', { class: 'muted' }, 'Hours: ' + o.hours))) : h('p', { class: 'muted' }, 'No office matches that search.')));
      }
      reg.addEventListener('change', draw); q.addEventListener('input', draw);
      root.append(h('h1', null, 'Office finder'), h('p', { class: 'sub' }, 'Find a customer service centre. Addresses and hours are sample values until verified.'),
        h('div', { class: 'split', style: 'margin-bottom:12px' }, field('Region', reg), field('Search', q)), list);
      draw();
    }
  };

  // ---------- TAMPERING (CONFIDENTIAL TIP-OFFS) ----------
  U.views.fraud = {
    render(root) {
      const cfg = api.getConfig();
      const cat = select(Object.keys(cfg.tip_cats).map((k) => [k, cfg.tip_cats[k]]), 'HOOKUP');
      const sub = select(cfg.suburbs.map((s) => [s.id, s.name]), 'boroko');
      const addr = h('input', { placeholder: 'Street, house or pole nearby', maxlength: '160' });
      const det = h('textarea', { maxlength: '300', placeholder: 'What did you see? Do not include your name.' });
      const out = h('div', { 'aria-live': 'polite' });
      const btn = h('button', { class: 'btn', type: 'button' }, 'Submit confidentially');
      btn.addEventListener('click', () => {
        btn.disabled = true;
        try {
          const r = api.createTip({ idempotency_key: newKey(), category: cat.value, suburb_id: sub.value, address_text: addr.value.trim(), details: det.value.trim() });
          out.replaceChildren(h('div', { class: 'card', style: 'margin-top:12px' },
            h('span', { class: 'pill ok' }, 'Received'),
            h('h2', { style: 'margin-top:8px' }, 'Save your access code'),
            h('p', null, 'Ticket ' + r.ticket_id + '. Access code:'),
            h('div', { class: 'token' }, r.access_code),
            h('p', { class: 'muted' }, 'Shown once. You need it with the ticket number to check progress. Staff see your report without any personal details.')));
          addr.value = ''; det.value = '';
        } catch (e) { fail(e); } finally { btn.disabled = false; }
      });

      const tid = h('input', { placeholder: 'Ticket number (RPU-…)', autocomplete: 'off' });
      const code = h('input', { placeholder: 'Access code', autocomplete: 'off' });
      const chk = h('div', { 'aria-live': 'polite' });
      const check = () => {
        try {
          const t = api.trackTicket({ ticket_id: tid.value.trim(), access_code: code.value.trim() });
          chk.replaceChildren(kvs([['Ticket', t.ticket_id], ['Stage', t.stage], ['Last update', fmtTime(t.updated_at)]]));
        } catch (e) { chk.replaceChildren(); fail(e); }
      };

      root.append(
        h('h1', null, 'Report power theft & meter tampering'),
        h('p', { class: 'sub' }, 'Confidential reporting for illegal connections, bypassed or broken meters.'),
        h('div', { class: 'notice bad' }, h('strong', null, 'Do not touch wires or meters. '), 'Reporting is confidential. If there is an immediate danger, call the hotline now.'),
        h('div', { class: 'split', style: 'margin-top:14px' },
          h('div', { class: 'card' }, h('h2', null, 'Submit a report'),
            field('Type of offence', cat), field('Suburb or town', sub), field('Location', addr), field('What you saw', det),
            h('div', { class: 'row', style: 'margin-top:10px' }, btn), out),
          h('div', { class: 'card' }, h('h2', null, 'Check a report'),
            field('Ticket number', tid), field('Access code', code),
            h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn ghost', type: 'button', onclick: check }, 'Check progress')),
            chk)));
    }
  };

  // ---------- SAFETY ----------
  U.views.safety = {
    render(root) {
      const b = api.getBrand();
      root.append(
        h('h1', null, 'Safety & outage reporting'),
        h('p', { class: 'sub' }, 'What to do when you find a fallen or sparking line, or a damaged pole.'),
        h('div', { class: 'notice bad' }, h('strong', null, 'Emergency: '), 'stay at least 10 metres away from fallen or sparking lines and call ' + b.hotline + ' now.'),
        h('div', { class: 'split', style: 'margin-top:14px' },
          h('div', { class: 'card' }, h('h2', null, 'If you see a fallen or sparking line'),
            h('ol', { class: 'steps' },
              h('li', null, h('strong', null, 'Stay back. '), 'Keep at least 10 metres from the line, the pole and anything touching it.'),
              h('li', null, h('strong', null, 'Warn others. '), 'Keep people, children and animals away.'),
              h('li', null, h('strong', null, 'Call now. '), 'Call ' + b.hotline + '. Give the suburb and the nearest pole tag.'),
              h('li', null, h('strong', null, 'Log it. '), 'Use the Faults tab so crews see it on the dispatch queue.'))),
          h('div', { class: 'card' }, h('h2', null, 'Pole tags'),
            h('p', null, 'Each pole has a tag such as POM-A12-04. Quoting it helps crews find the exact pole.'),
            h('p', { class: 'muted' }, 'Do not climb poles or touch cables. Crews isolate the line before anyone approaches.'))),
        h('div', { class: 'row', style: 'margin-top:14px' },
          h('button', { class: 'btn', type: 'button', onclick: () => go('tracker') }, 'Report a fault now'),
          h('button', { class: 'btn ghost', type: 'button', onclick: () => go('chat') }, 'Ask the assistant')));
    }
  };

  // ---------- ASSISTANT ----------
  U.views.chat = {
    render(root) {
      const log = h('div', { class: 'chat', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation' });
      const input = h('input', { placeholder: 'Ask about a blackout, a token, a ticket or the grid', 'aria-label': 'Message', maxlength: '500', autocomplete: 'off' });
      const chips = ['Report blackout at Waigani pole POM-A12-04', 'Fallen wire in Boroko, call urgently', 'Grid status in Port Moresby', 'How do I buy a token?', 'Which office is in Lae?', 'What is my last token?'];
      function botMsg(r) {
        return h('div', { class: 'msg bot' },
          r.tool ? h('span', { class: 'tool' }, 'Tool: ' + r.tool + '()') : null,
          h('div', null, r.text),
          r.lines && r.lines.length ? h('ul', null, r.lines.map((l) => h('li', null, l))) : null,
          r.actions && r.actions.length ? h('div', { class: 'chips' }, r.actions.map((a) => h('button', { type: 'button', onclick: () => go(a.nav) }, a.label))) : null);
      }
      function ask(text) {
        const t = String(text || '').trim();
        if (!t) return;
        log.append(h('div', { class: 'msg user' }, t));
        let r;
        try { r = bot.respond(t); } catch (e) { r = { text: 'Sorry, I could not process that. Please try again.', lines: [], tool: null, actions: [] }; }
        log.append(botMsg(r));
        log.scrollTop = log.scrollHeight;
        input.value = '';
        input.focus();
      }
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ask(input.value); } });
      log.append(botMsg({ text: 'Hi, I am the demo assistant. I use rules and the simulated back end, not a language model. Tokens are never shown in chat.', lines: [], tool: null, actions: [] }));
      root.append(
        h('h1', null, 'Assistant'),
        h('p', { class: 'sub' }, 'Ask in plain words. Reports go to the same dispatch queue as the Faults tab.'),
        h('div', { class: 'card' }, log,
          h('div', { class: 'chips', 'aria-label': 'Suggested questions' }, chips.map((c) => h('button', { type: 'button', onclick: () => ask(c) }, c))),
          h('div', { class: 'row' }, input, h('button', { class: 'auto btn', type: 'button', onclick: () => ask(input.value) }, 'Send'))));
    }
  };
})();
