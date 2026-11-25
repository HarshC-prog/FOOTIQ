/* FOOTIQ front-end — match operator and admin screens. */
(() => {
  'use strict';
  const { $, $$, esc, inr, api, toast, modal, crest, teamBlock, fTime, fDate, fDateLong, fDateTime, S, debounce } = FQ;
  const forbidden = (box, need) => {
    box.innerHTML = `<div class="empty"><h3>${S.user ? 'No access' : 'Please log in'}</h3><p style="margin:10px 0 16px">${S.user ? `This area is for ${need} accounts.` : 'Log in with an operator or admin account to continue.'}</p><a class="btn primary" href="#/login?next=${encodeURIComponent(location.hash)}">${S.user ? 'Switch account' : 'Log in'}</a></div>`;
  };

  // ------------------------------------------------------------ ticket validation (QR check-in)
  const validatorHtml = () => `<div class="card"><div class="card-title"><h3>Ticket validation</h3><span class="pill">Gate check</span></div>
    <p class="muted" style="margin-bottom:14px">Paste the code from a fan's QR ticket (or type the Booking ID for this demo) to check them in.</p>
    <div class="row" style="flex-wrap:nowrap"><input id="vcode" placeholder="e.g. FTQ-2026-100.a1b2c3d4e5" autocomplete="off" spellcheck="false"><button class="btn primary" id="vgo">Validate</button></div>
    <div id="vres" style="margin-top:14px"></div></div>`;
  function bindValidator(root) {
    const out = $('#vres', root); const input = $('#vcode', root);
    const show = (r) => {
      const b = r.booking;
      const info = b ? `<div class="muted" style="margin-top:8px">${esc(b.ref)} • ${esc(b.match.home.name)} vs ${esc(b.match.away.name)}<br>${esc(b.stands.join(', '))} • Seat ${esc(b.seats.map((s) => s.label).join(', '))} • ${inr(b.total)}</div>` : '';
      out.innerHTML = r.valid
        ? `<div class="result ok"><b style="font-size:18px">✓ Valid ticket — entry granted</b>${r.manual ? '<div class="tiny muted">Checked by booking ID (no QR signature).</div>' : ''}${info}</div>`
        : `<div class="result bad"><b style="font-size:18px">✗ ${esc(r.reason)}</b>${info}</div>`;
    };
    const go = async () => {
      const code = input.value.trim(); if (!code) return;
      try { show(await api('/tickets/validate', { method: 'POST', body: { code } })); input.select(); }
      catch (e) { show({ valid: false, reason: e.message }); }
    };
    $('#vgo', root).onclick = go;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }

  // ------------------------------------------------------------ OPERATOR DASHBOARD
  FQ.views.Operator = async (box, _p, query) => {
    if (!FQ.requireLogin(['operator', 'admin'])) { if (S.user) forbidden(box, 'operator or admin'); return; }
    box.innerHTML = FQ.skeleton(2);
    let list = await api('/operator/matches');
    let selected = +query.m || (list.find((x) => x.status === 'live') || list.find((x) => x.status === 'upcoming') || list[0] || {}).id;
    let mode = query.t === 'tickets' ? 'tickets' : 'control';
    let m = null, players = { home: [], away: [] };
    let evType = 'goal'; let minuteTouched = false;

    const sideList = () => `<h4 style="margin-bottom:10px">Matches</h4><div class="live-pick">${list.map((x) => `<button class="${x.id === selected ? 'on' : ''}" data-act="pick" data-id="${x.id}">
      <span><b>${esc(x.home.short)} v ${esc(x.away.short)}</b><br><span class="muted tiny">${fDate(x.kickoff)}${x.status !== 'upcoming' ? ` • ${x.score.home}–${x.score.away}` : ''}</span></span>
      <span class="pill ${x.status === 'live' ? 'live' : x.status === 'upcoming' ? 'gold' : ''}">${x.status === 'live' ? 'LIVE' : x.status}</span></button>`).join('')}</div>`;

    const head = () => {
      const pill = m.status === 'live' ? '<span class="pill live">LIVE MATCH</span>' : m.status === 'completed' ? '<span class="pill">FULL TIME</span>' : '<span class="pill gold">NOT STARTED</span>';
      return `<div class="card opscore"><div class="row" style="justify-content:center">${pill}<span class="muted tiny" style="letter-spacing:.14em;font-weight:800">CURRENT SCORE • <span id="op-min">${m.minute}'</span>${m.status === 'live' && !m.clock.running ? ' (clock paused)' : ''}</span></div>
        <div class="big" style="margin:12px 0 6px">${m.score.home} – ${m.score.away}</div>
        <div class="row" style="justify-content:center;gap:16px"><span>${crest(m.home, 'xs')} <b>${esc(m.home.name)}</b></span><span class="muted">vs</span><span><b>${esc(m.away.name)}</b> ${crest(m.away, 'xs')}</span></div>
        <div class="row" style="justify-content:center;margin-top:16px">
          ${m.status === 'upcoming' ? '<button class="btn primary" data-act="start">▶ Start match (kick-off)</button>' : ''}
          ${m.status === 'live' ? `<button class="btn" data-act="toggle">${m.clock.running ? '⏸ Pause clock' : '▶ Resume clock'}</button>
            <input id="setmin" type="number" min="0" max="130" placeholder="Min" style="width:84px"><button class="btn" data-act="setmin">Set minute</button>
            <button class="btn danger" data-act="finish">Full time</button>` : ''}
        </div></div>`;
    };

    const evList = () => `<div class="card"><h3 style="margin-bottom:12px">Published events</h3>${m.events.length ? `<div class="tablewrap"><table><tbody>${m.events.map((e) => `<tr><td><b>${e.minute}'</b></td><td>${{ goal: '⚽', yellow: '🟨', red: '🟥', sub: '🔄' }[e.type]}</td><td>${esc(m[e.side].short)}</td><td style="white-space:normal">${esc(e.text || e.player)}${e.assister ? `<small class="assist-by">Assist · ${esc(e.assister)}</small>` : ''}</td><td class="act"><button class="btn sm danger" data-act="undo" data-id="${e.id}">Undo</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nothing published yet.</p>'}</div>`;

    const playerOptions = (side) => players[side].map((p) => `<option value="${esc(p.name)}">#${p.number} ${esc(p.position || '')}</option>`).join('');

    const panelHtml = () => {
      const live = m.status === 'live'; const st = m.stats; const dis = live ? '' : 'disabled';
      const sr = (label, key, hv, av, max = 99) => `<div>${label}</div><input type="number" min="0" max="${max}" data-stat="${key}_home" value="${hv}" ${dis}><input type="number" min="0" max="${max}" data-stat="${key}_away" value="${av}" ${dis}>`;
      return `<div class="stack"><div id="op-head">${head()}</div>
        ${live ? '' : `<div class="card tight muted">${m.status === 'upcoming' ? 'Start the match to publish events and statistics.' : 'This match has finished. Events can still be undone if a correction is needed.'}</div>`}
        <div class="card"><h3 style="margin-bottom:14px">Update Match Event</h3>
          <div class="field"><label>Select event type</label><div class="evtypes">${[['goal', '⚽ Goal'], ['yellow', '🟨 Yellow Card'], ['red', '🟥 Red Card'], ['sub', '🔄 Substitution']].map(([k, l]) => `<button type="button" class="${evType === k ? 'on' : ''}" data-act="evtype" data-k="${k}" ${dis}>${l}</button>`).join('')}</div></div>
          <div class="two"><div class="field"><label>Team</label><select id="ev-team" ${dis}><option value="${m.home.id}">${esc(m.home.name)}</option><option value="${m.away.id}">${esc(m.away.name)}</option></select></div>
            <div class="field"><label>Match minute</label><input id="ev-min" type="number" min="0" max="130" value="${m.minute}" ${dis}></div></div>
          <div class="two"><div class="field"><label>${evType === 'sub' ? 'Player going off' : 'Player name'}</label><input id="ev-player" list="pl-list" placeholder="Select or type a player…" autocomplete="off" ${dis}><datalist id="pl-list">${playerOptions('home')}</datalist></div>
            <div class="field" id="in-wrap" style="${evType === 'sub' ? '' : 'display:none'}"><label>Player coming on</label><input id="ev-in" list="pl-list" placeholder="Select or type…" autocomplete="off" ${dis}></div></div>
          <div class="field" id="assist-wrap" style="${evType === 'goal' ? '' : 'display:none'}"><label>Assist (optional)</label><input id="ev-assister" list="pl-list" placeholder="Unassisted" autocomplete="off" ${dis}></div>
          <div class="field"><label>Commentary <span style="text-transform:none;letter-spacing:0;font-weight:500">(optional — auto-written if blank)</span></label><textarea id="ev-text" placeholder="Enter match event description…" ${dis}></textarea></div>
          <div id="ev-err"></div><button class="btn primary" data-act="publish" ${dis}>Publish Event</button></div>
        <div class="card"><h3 style="margin-bottom:14px">Update Team Statistics</h3>
          <div class="field"><div class="spread"><label style="margin:0">${esc(m.home.name)} possession</label><b id="pos-h">${st.possession[0]}%</b></div>
            <input id="poss" type="range" min="0" max="100" value="${st.possession[0]}" ${dis}><div class="spread"><label style="margin:0">${esc(m.away.name)} possession</label><b id="pos-a">${st.possession[1]}%</b></div></div>
          <div class="statgrid"><span></span><span class="h">${esc(m.home.short)}</span><span class="h">${esc(m.away.short)}</span>
            ${sr('Pass accuracy %', 'pass', st.passAccuracy[0], st.passAccuracy[1], 100)}${sr('Shots', 'shots', st.shots[0], st.shots[1])}${sr('Shots on target', 'sot', st.shotsOnTarget[0], st.shotsOnTarget[1])}${sr('Corners', 'corners', st.corners[0], st.corners[1])}${sr('Fouls', 'fouls', st.fouls[0], st.fouls[1])}</div>
          <div id="st-err" style="margin-top:12px"></div><button class="btn primary" style="margin-top:14px" data-act="stats" ${dis}>Update Statistics</button></div>
        <div id="op-events">${evList()}</div></div>`;
    };

    const act = async (fn, okMsg) => {
      try { const r = await fn(); if (r && r.id === m?.id) m = r; if (okMsg) toast(okMsg); return r; }
      catch (e) { toast(e.message, 'err'); return null; }
    };
    const refreshDynamic = () => { const h = $('#op-head', box); if (h) h.innerHTML = head(); const ev = $('#op-events', box); if (ev) ev.innerHTML = evList(); const side = $('#side', box); if (side) side.innerHTML = sideList(); };

    const loadMatch = async () => {
      if (!selected) { $('#panel', box).innerHTML = '<div class="empty">No matches yet.</div>'; return; }
      [m, players] = await Promise.all([api('/matches/' + selected), api(`/matches/${selected}/players`)]);
      minuteTouched = false;
      $('#panel', box).innerHTML = panelHtml();
    };

    const drawShell = async () => {
      box.innerHTML = `<div class="spread" style="margin-bottom:20px"><h2>Match Operator</h2>
        <div class="tabs"><button class="${mode === 'control' ? 'on' : ''}" data-act="mode" data-k="control">Match control</button><button class="${mode === 'tickets' ? 'on' : ''}" data-act="mode" data-k="tickets">Ticket validation</button></div></div>
        ${mode === 'tickets' ? `<div style="max-width:640px">${validatorHtml()}</div>` : '<div class="layout-side"><aside id="side"></aside><div id="panel"></div></div>'}`;
      if (mode === 'tickets') return bindValidator(box);
      $('#side', box).innerHTML = sideList();
      await loadMatch();
    };
    await drawShell();

    box.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-act]'); if (!t) return;
      const a = t.dataset.act;
      if (a === 'mode') { mode = t.dataset.k; await drawShell(); }
      else if (a === 'pick') { selected = +t.dataset.id; $('#side', box).innerHTML = sideList(); await loadMatch(); }
      else if (a === 'start') { await act(() => api(`/operator/matches/${m.id}/start`, { method: 'POST' }), 'Match started — fans can follow it live now.'); list = await api('/operator/matches'); $('#panel', box).innerHTML = panelHtml(); $('#side', box).innerHTML = sideList(); }
      else if (a === 'finish') { if (confirm('End the match (full time)?')) { await act(() => api(`/operator/matches/${m.id}/finish`, { method: 'POST' }), 'Full time.'); list = await api('/operator/matches'); $('#panel', box).innerHTML = panelHtml(); $('#side', box).innerHTML = sideList(); } }
      else if (a === 'toggle') { await act(() => api(`/operator/matches/${m.id}/clock`, { method: 'POST', body: { running: !m.clock.running } })); refreshDynamic(); }
      else if (a === 'setmin') { const v = $('#setmin', box).value; if (v === '') return; await act(() => api(`/operator/matches/${m.id}/clock`, { method: 'POST', body: { minute: Number(v) } }), 'Clock updated.'); refreshDynamic(); }
      else if (a === 'evtype') { evType = t.dataset.k; $$('.evtypes button', box).forEach((b) => b.classList.toggle('on', b.dataset.k === evType)); $('#in-wrap', box).style.display = evType === 'sub' ? '' : 'none'; $('#assist-wrap', box).style.display = evType === 'goal' ? '' : 'none'; $('#ev-player', box).previousElementSibling.textContent = evType === 'sub' ? 'Player going off' : 'Player name'; }
      else if (a === 'publish') {
        const body = { type: evType, teamId: Number($('#ev-team', box).value), player: $('#ev-player', box).value, playerIn: $('#ev-in', box).value, assister: $('#ev-assister', box).value, minute: $('#ev-min', box).value, text: $('#ev-text', box).value };
        $('#ev-err', box).innerHTML = '';
        try {
          m = await api(`/operator/matches/${m.id}/events`, { method: 'POST', body });
          toast(evType === 'goal' ? `Goal published — ${m.score.home}–${m.score.away}` : 'Event published to the live match centre');
          $('#ev-player', box).value = ''; $('#ev-in', box).value = ''; $('#ev-assister', box).value = ''; $('#ev-text', box).value = ''; minuteTouched = false;
          refreshDynamic();
        } catch (err) { $('#ev-err', box).innerHTML = `<div class="form-error">${esc(err.message)}</div>`; }
      } else if (a === 'undo') { if (confirm('Remove this event? A goal will also be taken off the score.')) { await act(() => api(`/operator/matches/${m.id}/events/${t.dataset.id}`, { method: 'DELETE' }), 'Event removed.'); refreshDynamic(); } }
      else if (a === 'stats') {
        const body = { poss_home: Number($('#poss', box).value) };
        $$('[data-stat]', box).forEach((i) => { body[i.dataset.stat] = Number(i.value); });
        $('#st-err', box).innerHTML = '';
        try { m = await api(`/operator/matches/${m.id}/stats`, { method: 'PUT', body }); toast('Statistics updated live.'); } catch (err) { $('#st-err', box).innerHTML = `<div class="form-error">${esc(err.message)}</div>`; }
      }
    });
    box.addEventListener('input', (e) => {
      if (e.target.id === 'poss') { $('#pos-h', box).textContent = e.target.value + '%'; $('#pos-a', box).textContent = 100 - e.target.value + '%'; }
      if (e.target.id === 'ev-min') minuteTouched = true;
    });
    box.addEventListener('change', (e) => { if (e.target.id === 'ev-team') { const side = Number(e.target.value) === m.home.id ? 'home' : 'away'; $('#pl-list', box).innerHTML = playerOptions(side); $('#ev-player', box).value = ''; $('#ev-in', box).value = ''; } });

    const timer = setInterval(() => {
      if (!box.isConnected) return clearInterval(timer);
      if (!m || m.status !== 'live') return;
      const c = m.clock; const off = c.serverNow - c.clientAt;
      const min = c.running ? Math.min(c.base + Math.floor((Date.now() + off - c.ref) / 60000), 120) : c.base;
      const el = $('#op-min', box); if (el) el.textContent = min + "'";
      const inp = $('#ev-min', box); if (inp && !minuteTouched && document.activeElement !== inp) inp.value = min;
    }, 1000);

    return {
      onMatch: (d) => {
        list = list.map((x) => (x.id === d.id ? { ...x, status: d.status, score: d.score, minute: d.minute } : x));
        if (mode === 'control' && m && d.id === m.id) { m = d; refreshDynamic(); }
        else if (mode === 'control') { const side = $('#side', box); if (side) side.innerHTML = sideList(); }
      },
      destroy: () => clearInterval(timer),
    };
  };

  // ------------------------------------------------------------ ADMIN
  const TABS = [['overview', 'Dashboard'], ['teams', 'Teams & Players'], ['fixtures', 'Fixtures'], ['stadiums', 'Stadiums & Seats'], ['bookings', 'Bookings'], ['reports', 'Reports & Analytics'], ['users', 'Users & Roles']];

  const dtable = (cols, rows, empty = 'Nothing here yet.') => rows.length
    ? `<div class="tablewrap"><table><thead><tr>${cols.map((c) => `<th ${c.align ? `style="text-align:${c.align}"` : ''}>${c.label}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td ${c.cls ? `class="${c.cls}"` : ''} ${c.align ? `style="text-align:${c.align}"` : ''}>${c.render(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : `<div class="empty">${empty}</div>`;
  const editBtns = (kind, id) => `<button class="btn sm" data-act="edit" data-kind="${kind}" data-id="${id}">Edit</button><button class="btn sm danger" data-act="del" data-kind="${kind}" data-id="${id}">Delete</button>`;

  function formModal({ title, fields, values = {}, submitLabel = 'Save', onSubmit }) {
    const input = (f) => {
      const v = values[f.key] ?? f.default ?? '';
      const common = `name="${f.key}" ${f.required === false ? '' : 'required'}`;
      if (f.type === 'select') return `<select ${common}>${f.options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
      if (f.type === 'datetime') return `<input type="datetime-local" ${common} value="${esc(String(v).slice(0, 16))}">`;
      if (f.type === 'number') return `<input type="number" ${common} value="${esc(v)}" ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''}>`;
      if (f.type === 'color') return `<input type="color" ${common} value="${esc(v || '#19d38b')}">`;
      return `<input type="${f.type || 'text'}" ${common} value="${esc(v)}" ${f.type === 'password' ? 'autocomplete="new-password"' : ''}>`;
    };
    const mdl = modal(`<h3 style="margin-bottom:16px">${esc(title)}</h3><form novalidate><div id="m-err"></div>${fields.map((f) => `<div class="field"><label>${esc(f.label)}</label>${input(f)}${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`).join('')}
      <div class="row" style="justify-content:flex-end;margin-top:8px"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">${esc(submitLabel)}</button></div></form>`);
    $('[data-close]', mdl.el).onclick = mdl.close;
    const first = $('input,select', mdl.el); if (first) first.focus();
    $('form', mdl.el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const out = {};
      for (const f of fields) {
        const el = e.target.elements[f.key]; let v = el.value;
        if (f.required !== false && v === '') { $('#m-err', mdl.el).innerHTML = `<div class="form-error">${esc(f.label)} is required</div>`; return; }
        if (f.type === 'number') v = v === '' ? undefined : Number(v);
        else if (f.type === 'select' && f.numeric) v = Number(v);
        else if (f.type === 'datetime') v = v ? `${v}:00+05:30` : undefined;
        out[f.key] = v;
      }
      try { await onSubmit(out); mdl.close(); } catch (err) { $('#m-err', mdl.el).innerHTML = `<div class="form-error">${esc(err.message)}</div>`; }
    });
  }

  FQ.views.Admin = async (box, { tab }) => {
    if (!FQ.requireLogin(['admin'])) { if (S.user) forbidden(box, 'admin'); return; }
    tab = TABS.some((t) => t[0] === tab) ? tab : 'overview';
    box.innerHTML = `<div class="layout-side"><nav class="sidenav card tight">${TABS.map(([k, l]) => `<a href="#/admin${k === 'overview' ? '' : '/' + k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</nav><div id="pane">${FQ.skeleton(2)}</div></div>`;
    const pane = $('#pane', box);
    const cache = {};
    const reload = async () => { try { await PANES[tab](); } catch (e) { pane.innerHTML = `<div class="empty">${esc(e.message)}</div>`; } };
    const save = async (kind, id, vals) => {
      const R = RESOURCES[kind];
      await api(`/admin/${R.path}${id ? '/' + id : ''}`, { method: id ? 'PUT' : 'POST', body: vals });
      toast(id ? 'Saved.' : 'Created.'); await reload();
    };

    // resource definitions (fields shown in the add/edit dialogs)
    const teamOpts = async () => (await api('/admin/teams')).map((t) => ({ value: t.id, label: t.name }));
    const stadOpts = async () => (await api('/admin/stadiums')).map((t) => ({ value: t.id, label: t.name }));
    const RESOURCES = {
      team: { path: 'teams', title: 'team', fields: async () => [{ key: 'name', label: 'Team name' }, { key: 'short', label: 'Short code', hint: 'Up to 5 letters, shown on crests' }, { key: 'color', label: 'Crest colour', type: 'color' }] },
      player: { path: 'players', title: 'player', fields: async () => [{ key: 'team_id', label: 'Team', type: 'select', numeric: true, options: await teamOpts() }, { key: 'name', label: 'Player name' }, { key: 'number', label: 'Shirt number', type: 'number', min: 1, max: 99, required: false }, { key: 'position', label: 'Position (GK/DF/MF/FW)', required: false }] },
      match: { path: 'matches', title: 'fixture', fields: async () => { const t = await teamOpts(); return [{ key: 'home_id', label: 'Home team', type: 'select', numeric: true, options: t }, { key: 'away_id', label: 'Away team', type: 'select', numeric: true, options: t }, { key: 'stadium_id', label: 'Stadium', type: 'select', numeric: true, options: await stadOpts() }, { key: 'kickoff', label: 'Kick-off (IST)', type: 'datetime' }, { key: 'status', label: 'Status', type: 'select', options: ['upcoming', 'live', 'completed'].map((v) => ({ value: v, label: v })) }]; } },
      stadium: { path: 'stadiums', title: 'stadium', fields: async () => [{ key: 'name', label: 'Stadium name' }, { key: 'city', label: 'City' }] },
      stand: { path: 'stands', title: 'stand', fields: async () => [{ key: 'stadium_id', label: 'Stadium', type: 'select', numeric: true, options: await stadOpts() }, { key: 'name', label: 'Stand name' }, { key: 'side', label: 'Side of pitch', type: 'select', options: ['west', 'east', 'north', 'south'].map((v) => ({ value: v, label: v })) }, { key: 'rows', label: 'Rows (A, B, C…)', type: 'number', min: 1, max: 26 }, { key: 'cols', label: 'Seats per row', type: 'number', min: 1, max: 30 }, { key: 'price', label: 'Ticket price (₹)', type: 'number', min: 0, max: 100000 }] },
    };

    const openForm = async (kind, row) => {
      const R = RESOURCES[kind];
      formModal({ title: `${row ? 'Edit' : 'Add'} ${R.title}`, fields: await R.fields(), values: row || {}, onSubmit: (v) => save(kind, row && row.id, v) });
    };

    const PANES = {
      async overview() {
        const d = await api('/admin/overview'); const t = d.totals;
        const max = Math.max(1, ...d.byDay.map((x) => x.revenue));
        pane.innerHTML = `<div class="stack"><div class="spread"><h2>Dashboard Overview</h2><span class="pill green">Live from database</span></div>
          <div class="grid g4"><div class="card kpi"><div class="l">Total Users</div><div class="n">${t.users.toLocaleString('en-IN')}</div></div><div class="card kpi"><div class="l">Bookings</div><div class="n">${t.bookings.toLocaleString('en-IN')}</div><div class="s">${t.tickets} tickets • ${t.cancelled} cancelled</div></div>
            <div class="card kpi"><div class="l">Matches</div><div class="n">${t.matches}</div></div><div class="card kpi"><div class="l">Revenue</div><div class="n">${inr(t.revenue)}</div><div class="s">${t.checkedIn} bookings checked in</div></div></div>
          <div class="card"><div class="card-title"><h3>Revenue — last days</h3><a class="btn sm ghost" href="#/admin/reports">Full reports →</a></div>
            <div class="daybars">${d.byDay.map((x) => `<div title="${esc(x.day)}: ${x.bookings} bookings, ${inr(x.revenue)}"><i style="height:${Math.max(2, (x.revenue / max) * 100)}%"></i><span>${esc(x.day.slice(8))}/${esc(x.day.slice(5, 7))}</span></div>`).join('') || '<div class="muted">No bookings yet.</div>'}</div></div>
          <div><h3 style="margin-bottom:12px">Management</h3><div class="grid g2 mgmt">${[['teams', 'Manage Teams & Players'], ['fixtures', 'Manage Fixtures'], ['stadiums', 'Manage Stadiums & Seats'], ['bookings', 'Manage Bookings'], ['reports', 'View Reports & Analytics'], ['users', 'Manage Users & Roles']].map(([k, l]) => `<a href="#/admin/${k}">${l}<span>→</span></a>`).join('')}</div></div></div>`;
      },
      async teams() {
        const [teams, players] = await Promise.all([api('/admin/teams'), api('/admin/players')]);
        cache.players = players;
        const filter = cache.teamFilter || '';
        const rows = players.filter((p) => !filter || String(p.team_id) === String(filter));
        pane.innerHTML = `<div class="stack"><div class="card"><div class="card-title"><h3>Teams</h3><button class="btn primary sm" data-act="add" data-kind="team">+ Add team</button></div>
          ${dtable([{ label: 'Team', render: (t) => `${crest(t, 'xs')} ${esc(t.name)}` }, { label: 'Code', render: (t) => esc(t.short) }, { label: 'Players', render: (t) => t.players }, { label: '', cls: 'act', render: (t) => editBtns('team', t.id) }], teams)}</div>
          <div class="card"><div class="card-title"><h3>Players</h3><div class="row"><select id="pf" style="width:auto"><option value="">All teams</option>${teams.map((t) => `<option value="${t.id}" ${String(t.id) === String(filter) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select><button class="btn primary sm" data-act="add" data-kind="player">+ Add player</button></div></div>
          ${dtable([{ label: '#', render: (p) => p.number ?? '–' }, { label: 'Player', render: (p) => esc(p.name) }, { label: 'Pos', render: (p) => esc(p.position || '–') }, { label: 'Team', render: (p) => esc(p.team) }, { label: '', cls: 'act', render: (p) => editBtns('player', p.id) }], rows)}</div></div>`;
        cache.teams = teams;
      },
      async fixtures() {
        const rows = await api('/admin/matches'); cache.matches = rows;
        pane.innerHTML = `<div class="card"><div class="card-title"><h3>Fixtures</h3><button class="btn primary sm" data-act="add" data-kind="match">+ Add fixture</button></div>
          ${dtable([{ label: 'Fixture', render: (m) => `<b>${esc(m.home)}</b> vs <b>${esc(m.away)}</b>` }, { label: 'Stadium', render: (m) => esc(m.stadium) }, { label: 'Kick-off', render: (m) => fDateTime(m.kickoff) }, { label: 'Status', render: (m) => `<span class="pill ${m.status === 'live' ? 'live' : m.status === 'upcoming' ? 'gold' : ''}">${m.status}</span>` }, { label: 'Score', render: (m) => (m.status === 'upcoming' ? '–' : `${m.home_score} – ${m.away_score}`) }, { label: 'Tickets sold', render: (m) => m.sold }, { label: '', cls: 'act', render: (m) => editBtns('match', m.id) }], rows)}
          <p class="muted tiny" style="margin-top:10px">Scores and events are managed from the Operator dashboard while a match is live.</p></div>`;
      },
      async stadiums() {
        const [stads, stands] = await Promise.all([api('/admin/stadiums'), api('/admin/stands')]);
        cache.stadiums = stads; cache.stands = stands;
        pane.innerHTML = `<div class="stack"><div class="card"><div class="card-title"><h3>Stadiums</h3><button class="btn primary sm" data-act="add" data-kind="stadium">+ Add stadium</button></div>
          ${dtable([{ label: 'Stadium', render: (s) => esc(s.name) }, { label: 'City', render: (s) => esc(s.city) }, { label: 'Stands', render: (s) => s.stands }, { label: 'Capacity', render: (s) => s.capacity }, { label: '', cls: 'act', render: (s) => editBtns('stadium', s.id) }], stads)}</div>
          <div class="card"><div class="card-title"><h3>Stands &amp; seats</h3><button class="btn primary sm" data-act="add" data-kind="stand">+ Add stand</button></div>
          ${dtable([{ label: 'Stadium', render: (s) => esc(s.stadium) }, { label: 'Stand', render: (s) => esc(s.name) }, { label: 'Side', render: (s) => esc(s.side) }, { label: 'Layout', render: (s) => `${s.rows} rows × ${s.cols}` }, { label: 'Seats', render: (s) => s.seats }, { label: 'Price', render: (s) => inr(s.price) }, { label: '', cls: 'act', render: (s) => editBtns('stand', s.id) }], stands)}
          <p class="muted tiny" style="margin-top:10px">Adding a stand generates its seats automatically. Price changes apply to future bookings only.</p></div></div>`;
      },
      async bookings() {
        const rows = await api('/admin/bookings'); cache.bookings = rows;
        const filter = (cache.bq || '').toLowerCase();
        const shown = rows.filter((b) => !filter || [b.ref, b.user, b.email, b.match, b.seats].join(' ').toLowerCase().includes(filter));
        pane.innerHTML = `<div class="stack"><div class="card"><div class="card-title"><h3>Bookings</h3><input id="bq" placeholder="Search ref, fan, match…" value="${esc(cache.bq || '')}" style="max-width:260px"></div>
          ${dtable([{ label: 'Booking', render: (b) => `<b>${esc(b.ref)}</b>` }, { label: 'Fan', render: (b) => esc(b.user) }, { label: 'Match', render: (b) => esc(b.match) }, { label: 'Seats', render: (b) => esc(b.seats || '') }, { label: 'Total', render: (b) => inr(b.total) }, { label: 'Status', render: (b) => (b.status === 'cancelled' ? '<span class="pill red">cancelled</span>' : b.checkedIn ? '<span class="pill gold">checked in</span>' : '<span class="pill green">confirmed</span>') }, { label: 'Booked', render: (b) => esc(b.createdAt.slice(0, 16)) }, { label: '', cls: 'act', render: (b) => (b.status === 'confirmed' && !b.checkedIn ? `<button class="btn sm danger" data-act="cancel" data-ref="${esc(b.ref)}">Cancel</button>` : '') }], shown)}</div>
          <div style="max-width:640px">${validatorHtml()}</div></div>`;
        bindValidator(pane);
        const q = $('#bq', pane);
        q.addEventListener('input', () => { cache.bq = q.value; const pos = q.selectionStart; PANES.bookings().then(() => { const n = $('#bq', pane); n.focus(); n.setSelectionRange(pos, pos); }); });
      },
      async reports() {
        const d = await api('/admin/overview');
        const maxStand = Math.max(1, ...d.byStand.map((s) => s.revenue));
        const maxDay = Math.max(1, ...d.byDay.map((x) => x.revenue));
        pane.innerHTML = `<div class="stack"><h2>Reports &amp; Analytics</h2>
          <div class="grid g3"><div class="card kpi"><div class="l">Tickets sold</div><div class="n">${d.totals.tickets}</div></div><div class="card kpi"><div class="l">Revenue</div><div class="n">${inr(d.totals.revenue)}</div></div><div class="card kpi"><div class="l">Avg. booking value</div><div class="n">${d.totals.bookings ? inr(Math.round(d.totals.revenue / d.totals.bookings)) : '–'}</div></div></div>
          <div class="card"><h3 style="margin-bottom:6px">Seats sold by match</h3><p class="muted tiny">Bar shows % of stadium capacity sold.</p>
            ${d.byMatch.map((m) => { const pct = m.capacity ? Math.round((m.tickets / m.capacity) * 100) : 0; return `<div class="hbar"><span><b>${esc(m.label)}</b></span><div class="track"><div class="fill" style="width:${pct}%"></div></div><span class="muted">${m.tickets}/${m.capacity} • ${inr(m.revenue)}</span></div>`; }).join('')}</div>
          <div class="grid g2" style="align-items:start"><div class="card"><h3 style="margin-bottom:6px">Revenue by stand</h3>${d.byStand.map((s) => `<div class="hbar" style="grid-template-columns:96px 1fr 110px"><span>${esc(s.stand)}</span><div class="track"><div class="fill" style="width:${(s.revenue / maxStand) * 100}%"></div></div><span class="muted">${inr(s.revenue)}</span></div>`).join('') || '<div class="muted">No sales yet.</div>'}</div>
            <div class="card"><h3 style="margin-bottom:6px">Daily revenue</h3><div class="daybars">${d.byDay.map((x) => `<div title="${esc(x.day)}: ${x.bookings} bookings, ${inr(x.revenue)}"><i style="height:${Math.max(2, (x.revenue / maxDay) * 100)}%"></i><span>${esc(x.day.slice(8))}/${esc(x.day.slice(5, 7))}</span></div>`).join('') || '<div class="muted">No bookings yet.</div>'}</div></div></div></div>`;
      },
      async users() {
        const rows = await api('/admin/users'); cache.users = rows;
        pane.innerHTML = `<div class="card"><div class="card-title"><h3>Users &amp; roles</h3><button class="btn primary sm" data-act="adduser">+ Add user</button></div>
          ${dtable([{ label: 'Name', render: (u) => esc(u.name) }, { label: 'Email', render: (u) => esc(u.email) }, { label: 'Role', render: (u) => `<select data-act="role" data-id="${u.id}" ${u.id === S.user.id ? 'disabled' : ''}>${['fan', 'operator', 'admin'].map((r) => `<option ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>` }, { label: 'Bookings', render: (u) => u.bookings }, { label: 'Joined', render: (u) => esc(u.createdAt.slice(0, 10)) }, { label: '', cls: 'act', render: (u) => (u.id === S.user.id ? '<span class="muted tiny">you</span>' : `<button class="btn sm danger" data-act="deluser" data-id="${u.id}">Delete</button>`) }], rows)}</div>`;
      },
    };

    box.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-act]'); if (!t) return;
      const a = t.dataset.act; const kind = t.dataset.kind; const id = Number(t.dataset.id);
      try {
        if (a === 'add') await openForm(kind);
        else if (a === 'edit') {
          const src = { team: cache.teams, player: cache.players, match: cache.matches, stadium: cache.stadiums, stand: cache.stands }[kind];
          await openForm(kind, src.find((r) => r.id === id));
        } else if (a === 'del') {
          if (!confirm('Delete this record? This cannot be undone.')) return;
          await api(`/admin/${RESOURCES[kind].path}/${id}`, { method: 'DELETE' }); toast('Deleted.'); await reload();
        } else if (a === 'cancel') {
          if (!confirm(`Cancel booking ${t.dataset.ref} and release its seats?`)) return;
          await api(`/admin/bookings/${encodeURIComponent(t.dataset.ref)}/cancel`, { method: 'POST' }); toast('Booking cancelled.'); await reload();
        } else if (a === 'adduser') {
          formModal({ title: 'Add user', submitLabel: 'Create user', fields: [{ key: 'name', label: 'Full name' }, { key: 'email', label: 'Email', type: 'email' }, { key: 'password', label: 'Temporary password', type: 'password', hint: 'At least 6 characters' }, { key: 'role', label: 'Role', type: 'select', options: ['fan', 'operator', 'admin'].map((v) => ({ value: v, label: v })) }], onSubmit: async (v) => { await api('/admin/users', { method: 'POST', body: v }); toast('User created.'); await reload(); } });
        } else if (a === 'deluser') {
          if (!confirm('Delete this user?')) return;
          await api(`/admin/users/${id}`, { method: 'DELETE' }); toast('User deleted.'); await reload();
        }
      } catch (err) { toast(err.message, 'err'); }
    });
    box.addEventListener('change', async (e) => {
      const t = e.target;
      if (t.id === 'pf') { cache.teamFilter = t.value; reload(); }
      if (t.dataset.act === 'role') {
        try { await api(`/admin/users/${t.dataset.id}`, { method: 'PUT', body: { role: t.value } }); toast('Role updated.'); } catch (err) { toast(err.message, 'err'); await reload(); }
      }
    });

    await reload();
    const refresh = debounce(() => { if (['overview', 'reports', 'bookings', 'fixtures'].includes(tab) && !document.querySelector('.overlay') && document.activeElement?.id !== 'bq') reload(); }, 400);
    return { onSeats: refresh, onMatch: refresh };
  };
})();
