/* FOOTIQ front-end — core, fan-facing screens. Staff screens live in staff.js. */
(() => {
  'use strict';
  const FQ = (window.FQ = { views: {} });
  const S = { user: null, token: null, cart: null, view: null, navId: 0, justBooked: null };
  FQ.S = S;

  // ------------------------------------------------------------ utilities
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
  const IST = 'Asia/Kolkata';
  const fmt = (iso, o) => new Intl.DateTimeFormat('en-IN', { timeZone: IST, ...o }).format(new Date(iso));
  const fTime = (iso) => fmt(iso, { hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase();
  const fDate = (iso) => fmt(iso, { day: 'numeric', month: 'long' });
  const fDateLong = (iso) => fmt(iso, { day: 'numeric', month: 'short', year: 'numeric' });
  const fDateTime = (iso) => `${fDateLong(iso)}, ${fTime(iso)}`;
  Object.assign(FQ, { $, $$, esc, inr, fTime, fDate, fDateLong, fDateTime });

  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'goal' ? 6000 : 4200);
  }
  FQ.toast = toast;

  async function api(path, { method = 'GET', body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (S.token) headers.Authorization = 'Bearer ' + S.token;
    let res;
    try { res = await fetch('/api' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }); }
    catch (_) { throw Object.assign(new Error('Cannot reach the FOOTIQ server. Is it still running?'), { status: 0 }); }
    let data = null;
    try { data = await res.json(); } catch (_) { /* empty */ }
    if (data && data.clock && data.clock.serverNow) data.clock.clientAt = Date.now();
    if (!res.ok) {
      if (res.status === 401 && S.token) { setSession(null, null); renderChrome(); }
      throw Object.assign(new Error((data && data.error) || 'Request failed'), { status: res.status, data });
    }
    return data;
  }
  FQ.api = api;

  function setSession(token, user) {
    S.token = token; S.user = user;
    try { token ? localStorage.setItem('footiq', JSON.stringify({ token, user })) : localStorage.removeItem('footiq'); } catch (_) { /* private mode */ }
  }
  function loadSession() {
    try { const v = JSON.parse(localStorage.getItem('footiq') || 'null'); if (v) { S.token = v.token; S.user = v.user; } } catch (_) { /* ignore */ }
  }
  const isStaff = () => S.user && (S.user.role === 'operator' || S.user.role === 'admin');
  FQ.isStaff = isStaff;
  function requireLogin(roles) {
    if (!S.user) { location.hash = '#/login?next=' + encodeURIComponent(location.hash || '#/'); return false; }
    if (roles && !roles.includes(S.user.role)) return false;
    return true;
  }
  FQ.requireLogin = requireLogin;

  function modal(html) {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov);
    return { el: $('.modal', ov), close };
  }
  FQ.modal = modal;

  // ------------------------------------------------------------ shared components
  const TEAM_LOGOS = {
    'Mumbai City FC': 'mumbai-city-fc.svg', 'Mohun Bagan SG': 'mohun-bagan-super-giant.svg',
    'Bengaluru FC': 'bengaluru-fc.svg', 'Kerala Blasters': 'kerala-blasters-fc.svg',
    'FC Goa': 'fc-goa.svg', 'East Bengal': 'east-bengal-fc.svg',
    'Chennaiyin FC': 'chennaiyin-fc.svg', 'NorthEast United': 'northeast-united-fc.svg',
  };
  const crest = (t, cls = '') => `<span class="crest ${cls} ${TEAM_LOGOS[t.name] ? 'has-logo' : ''}" style="--c:${esc(t.color)}" title="${esc(t.name)}" aria-label="${esc(t.name)}">${esc(t.short)}${TEAM_LOGOS[t.name] ? `<img src="/logos/${TEAM_LOGOS[t.name]}" alt="" loading="lazy" onerror="this.parentElement.classList.remove('has-logo')">` : ''}</span>`;
  const teamBlock = (t) => `<div class="team">${crest(t)}<span>${esc(t.name)}</span></div>`;
  Object.assign(FQ, { crest, teamBlock });

  function qrSvg(rows) {
    const b = 3, n = rows.length + b * 2;
    let d = '';
    rows.forEach((r, y) => { for (let x = 0; x < r.length; x++) if (r[x] === '1') d += `M${x + b},${y + b}h1v1h-1z`; });
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="Ticket QR code"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  function matchCard(m, { featured = false } = {}) {
    if (m.status === 'live') {
      return `<article class="card mcard live">
        <div class="meta"><span>${esc(m.competition)} • LIVE MATCH</span><span class="pill live" data-clock="${m.id}">LIVE • ${m.minute}'</span></div>
        <div class="vs">${teamBlock(m.home)}<div class="score">${m.score.home} – ${m.score.away}</div>${teamBlock(m.away)}</div>
        <div class="venue">${esc(m.stadium.name)}</div>
        <a class="btn primary" href="#/live/${m.id}">View Live Match Centre →</a></article>`;
    }
    const avail = m.tickets.available > 0;
    return `<article class="card mcard ${featured ? 'featured' : ''}">
      <div class="meta"><span>${esc(m.competition)} • ${fTime(m.kickoff)}</span><span class="pill ${avail ? 'green' : 'red'}">${avail ? 'Tickets available' : 'Sold out'}</span></div>
      <div class="vs">${teamBlock(m.home)}<div class="mid">VS</div>${teamBlock(m.away)}</div>
      <div class="venue">${esc(m.stadium.name)} • ${fDate(m.kickoff)}</div>
      <a class="btn primary" href="#/book/${m.id}">Book Tickets</a></article>`;
  }

  const skeleton = (n = 3) => `<div class="grid auto">${'<div class="skeleton"></div>'.repeat(n)}</div>`;
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  Object.assign(FQ, { matchCard, skeleton, debounce, qrSvg });

  // ------------------------------------------------------------ HOME
  FQ.views.Home = async (box) => {
    box.innerHTML = skeleton(3);
    const load = async () => {
      const d = await api('/home');
      box.innerHTML = `
        <section class="hero">
          <div class="hero-copy" style="position:relative">
            <div class="eyebrow">THE INDIAN SUPER LEAGUE</div>
            <h1>Matchday <span>Starts Here.</span></h1>
            <p class="lead">Find your seat, follow every moment, and stay close to the clubs you love.</p>
            <a class="btn primary" href="#/matches">Explore Matches →</a>
          </div>
          <div class="hero-featured" style="position:relative">${d.featured ? matchCard(d.featured, { featured: true }) : '<div class="empty">No upcoming fixtures yet.</div>'}</div>
        </section>
        ${d.live.length ? `<div class="section-head"><h2>Live Match</h2></div><div class="grid auto">${d.live.map((m) => matchCard(m)).join('')}</div>` : ''}
        <div class="section-head"><h2>Upcoming Matches</h2><a class="btn ghost sm" href="#/matches">All fixtures →</a></div>
        <div class="grid auto">${d.upcoming.length ? d.upcoming.map((m) => matchCard(m)).join('') : '<div class="empty">Nothing scheduled.</div>'}</div>
        <div class="linkrow">
          <a href="#/matches">Fixtures <span>→</span></a>
          <a href="#/statistics">Statistics <span>→</span></a>
          <a href="#/tickets">My Tickets <span>→</span></a>
        </div>`;
    };
    await load();
    const reload = debounce(() => load().catch(() => {}), 250);
    const t = setInterval(() => { if (!box.isConnected) clearInterval(t); else if (box.querySelector('[data-clock]')) reload(); }, 30000);
    return { onMatch: reload, onSeats: reload, onReconnect: reload, destroy: () => clearInterval(t) };
  };

  // ------------------------------------------------------------ MATCHES
  FQ.views.Matches = async (box, _p, query) => {
    box.innerHTML = skeleton(4);
    let all = [];
    let tab = ['upcoming', 'live', 'completed'].includes(query.s) ? query.s : 'upcoming';
    let team = '';
    let search = '';
    const teams = () => {
      const map = new Map();
      all.forEach((m) => { map.set(m.home.id, m.home.name); map.set(m.away.id, m.away.name); });
      return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    };
    const row = (m) => {
      const act = m.status === 'upcoming'
        ? `<span class="muted tiny">From ${inr(m.tickets.from)}${m.tickets.available ? '' : ' • Sold out'}</span><a class="btn primary sm" href="#/book/${m.id}">Book Now</a>`
        : m.status === 'live'
          ? `<a class="btn primary sm" href="#/live/${m.id}">View Live Match</a>`
          : `<a class="btn ghost sm" href="#/live/${m.id}">Match Summary</a>`;
      const when = m.status === 'upcoming' ? `UPCOMING • ${fTime(m.kickoff)}` : m.status === 'live' ? `<span class="pill live">LIVE • ${m.minute} MINUTES</span>` : `FULL TIME • ${fDate(m.kickoff)}`;
      const mid = m.status === 'upcoming' ? '<span class="muted">VS</span>' : `<span class="sc">${m.score.home} – ${m.score.away}</span>`;
      return `<article class="card fixture">
        <div class="when">${when}</div>
        <div><div class="teams">${crest(m.home, 'sm')}<span>${esc(m.home.name)}</span>${mid}<span>${esc(m.away.name)}</span>${crest(m.away, 'sm')}</div>
          <div class="muted tiny" style="margin-top:6px">${esc(m.stadium.name)} • ${fDate(m.kickoff)}</div></div>
        <div class="act">${act}</div></article>`;
    };
    const draw = () => {
      const count = (s) => all.filter((m) => m.status === s).length;
      const term = search.trim().toLocaleLowerCase();
      const list = all.filter((m) => {
        const text = [m.home.name, m.away.name, m.stadium.name, m.competition].join(' ').toLocaleLowerCase();
        return m.status === tab && (!team || m.home.id === +team || m.away.id === +team) && (!term || text.includes(term));
      });
      box.innerHTML = `
        <div class="matches-heading"><div><p class="eyebrow">THE FIXTURES</p><h2>Find your match</h2><p class="muted">Browse upcoming games, live action and results.</p></div>
          <div class="tabs" role="tablist" aria-label="Match status">${['upcoming', 'live', 'completed'].map((s) => `<button class="${tab === s ? 'on' : ''}" role="tab" aria-selected="${tab === s}" data-act="tab" data-s="${s}">${s[0].toUpperCase() + s.slice(1)}<span class="n">${count(s)}</span></button>`).join('')}</div></div>
        <div class="filters"><label class="search-field"><span>Search</span><input type="search" data-act="search" placeholder="Team, stadium or league" value="${esc(search)}" aria-label="Search matches"></label>
          <label class="team-field"><span>Team</span>
          <select data-act="team"><option value="">All teams</option>${teams().map(([id, n]) => `<option value="${id}" ${String(id) === String(team) ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label></div>
        <div class="results-count" aria-live="polite">${list.length} ${list.length === 1 ? 'match' : 'matches'}</div>
        <div class="stack">${list.length ? list.map(row).join('') : `<div class="empty"><strong>No matches found</strong><p>Try another search or clear your filters.</p><button class="btn sm ghost" data-act="clear">Clear filters</button></div>`}</div>`;
    };
    const load = async () => { all = await api('/matches'); draw(); };
    await load();
    box.addEventListener('click', (e) => { const b = e.target.closest('[data-act=tab]'); if (b) { tab = b.dataset.s; draw(); } });
    box.addEventListener('click', (e) => { if (e.target.closest('[data-act=clear]')) { team = ''; search = ''; draw(); } });
    box.addEventListener('input', (e) => { if (e.target.dataset.act === 'search') { const pos = e.target.selectionStart; search = e.target.value; draw(); const input = box.querySelector('[data-act=search]'); input.focus(); input.setSelectionRange(pos, pos); } });
    box.addEventListener('change', (e) => { if (e.target.dataset.act === 'team') { team = e.target.value; draw(); } });
    const reload = debounce(() => load().catch(() => {}), 250);
    return { onMatch: reload, onSeats: reload, onReconnect: reload };
  };

  // ------------------------------------------------------------ SEAT SELECTION
  function stadiumSvg(stands, active) {
    const by = Object.fromEntries(stands.map((s) => [s.side, s]));
    const pos = { west: { x: 14, y: 110, w: 122, h: 200 }, east: { x: 504, y: 110, w: 122, h: 200 }, north: { x: 150, y: 14, w: 340, h: 76 }, south: { x: 150, y: 330, w: 340, h: 76 } };
    const g = (side) => {
      const s = by[side]; const p = pos[side];
      if (!s) return `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="14" fill="none" stroke="#2c3d6f" stroke-dasharray="6 6"/>`;
      const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
      return `<g class="stand ${active === side ? 'on' : ''} ${s.available ? '' : 'full'}" data-act="stand" data-side="${side}" role="button" tabindex="0" aria-label="${esc(s.name)}">
        <rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="14"/>
        <text class="t1" x="${cx}" y="${cy - 14}">${esc(s.name)}</text><text class="t2" x="${cx}" y="${cy + 6}">${inr(s.price)}</text>
        <text class="t3" x="${cx}" y="${cy + 24}">${s.available ? s.available + ' left' : 'Sold out'}</text></g>`;
    };
    return `<svg viewBox="0 0 640 420" role="img" aria-label="Stadium map">
      <defs><pattern id="grass" width="40" height="10" patternUnits="userSpaceOnUse"><rect width="20" height="10" fill="#0e6a44"/><rect x="20" width="20" height="10" fill="#0c5e3c"/></pattern></defs>
      <rect x="150" y="106" width="340" height="208" rx="10" fill="url(#grass)" stroke="#1d8a5c" stroke-width="2"/>
      <g fill="none" stroke="rgba(255,255,255,.5)" stroke-width="1.6"><rect x="160" y="116" width="320" height="188"/><path d="M320 116v188"/><circle cx="320" cy="210" r="30"/>
        <rect x="160" y="160" width="46" height="100"/><rect x="434" y="160" width="46" height="100"/><rect x="160" y="188" width="16" height="44"/><rect x="464" y="188" width="16" height="44"/></g>
      <text x="320" y="296" text-anchor="middle" class="pitch-note">FOOTBALL PITCH</text>
      ${['north', 'south', 'west', 'east'].map(g).join('')}</svg>`;
  }

  FQ.views.Book = async (box, { id }) => {
    box.innerHTML = skeleton(2);
    let data = await api(`/matches/${id}/seats`);
    if (!S.cart || S.cart.matchId !== +id) S.cart = { matchId: +id, seats: new Map() };
    const cart = S.cart;
    let active = (data.stands.find((s) => s.available) || data.stands[0] || {}).side;

    const sync = (notify) => {
      const idx = new Map();
      data.stands.forEach((st) => st.seats.forEach((s) => idx.set(s.id, { s, st })));
      for (const [sid, v] of [...cart.seats]) {
        const f = idx.get(sid);
        if (!f || f.s.status !== 'available') { cart.seats.delete(sid); if (notify) toast(`Seat ${v.stand} ${v.label} was just taken by someone else.`, 'err'); }
      }
      return idx;
    };
    let idx = sync(false);

    const draw = () => {
      const m = data.match;
      const st = data.stands.find((x) => x.side === active);
      const picked = [...cart.seats.values()];
      const total = picked.reduce((a, s) => a + s.price, 0);
      const rows = {};
      if (st) st.seats.forEach((s) => (rows[s.row] = rows[s.row] || []).push(s));
      box.innerHTML = `
        <div class="spread" style="margin-bottom:18px"><div><h2>Select Your Seats</h2>
          <p class="muted" style="margin-top:6px">${esc(m.home.name)} vs ${esc(m.away.name)} • ${esc(m.stadium.name)} • ${fDateTime(m.kickoff)}</p></div>
          <a class="btn ghost sm" href="#/matches">← All fixtures</a></div>
        ${data.bookable ? '' : `<div class="form-error">Booking is closed for this match${m.status === 'live' ? ' — it is already live.' : '.'} <a href="#/live/${m.id}" style="text-decoration:underline">Open the match centre</a></div>`}
        <div class="book-layout"><div class="stack">
          <div class="card stadium">${stadiumSvg(data.stands, active)}
            <div class="legend"><span><i class="sw"></i>Available</span><span><i class="sw sel"></i>Selected</span><span><i class="sw bk"></i>Booked</span>${S.user ? '<span><i class="sw mine"></i>Your seats</span>' : ''}</div></div>
          ${st ? `<div class="card"><div class="card-title"><h3>${esc(st.name)} – ${inr(st.price)}</h3><span class="muted">${st.available} of ${st.seats.length} seats available</span></div>
            <div class="seatgrid">${Object.keys(rows).map((r) => `<div class="seatrow"><span class="rl">${r}</span>${rows[r].map((s) => {
              const sel = cart.seats.has(s.id);
              const cls = sel ? 'sel' : s.status === 'booked' ? 'bk' : s.status === 'mine' ? 'mine' : '';
              return `<button class="seat ${cls}" data-act="seat" data-id="${s.id}" ${s.status !== 'available' || !data.bookable ? 'disabled' : ''} aria-pressed="${sel}" aria-label="Seat ${s.label} ${sel ? 'selected' : s.status}">${s.label}</button>`;
            }).join('')}</div>`).join('')}</div></div>` : ''}
        </div>
        <aside class="card summary"><h3 style="margin-bottom:12px">Selected seats</h3>
          ${picked.length ? `<div class="chips">${picked.map((s) => `<span class="chip" title="${esc(s.stand)}">${esc(s.label)}<button data-act="unsel" data-id="${s.id}" aria-label="Remove ${esc(s.label)}">×</button></span>`).join('')}</div>
            <ul class="muted tiny" style="padding-left:18px;margin:12px 0 0">${picked.map((s) => `<li>${esc(s.stand)} ${esc(s.label)} — ${inr(s.price)}</li>`).join('')}</ul>` : '<p class="muted">Pick up to 6 seats from the map. Prices vary by stand.</p>'}
          <div class="total"><span class="muted">Total amount</span><b>${inr(total)}</b></div>
          <button class="btn primary block" style="margin-top:14px" data-act="continue" ${picked.length && data.bookable ? '' : 'disabled'}>Continue to Booking</button>
          ${S.user ? '' : '<p class="muted tiny" style="margin-top:10px">You will be asked to log in before paying.</p>'}
        </aside></div>`;
    };
    draw();

    box.addEventListener('click', (e) => {
      const t = e.target.closest('[data-act]'); if (!t) return;
      const act = t.dataset.act;
      if (act === 'stand') { active = t.dataset.side; draw(); }
      else if (act === 'seat') {
        const sid = +t.dataset.id; const f = idx.get(sid); if (!f) return;
        if (cart.seats.has(sid)) cart.seats.delete(sid);
        else if (cart.seats.size >= 6) return toast('You can book up to 6 seats at a time.', 'err');
        else cart.seats.set(sid, { id: sid, label: f.s.label, stand: f.st.name, price: f.st.price });
        draw();
      } else if (act === 'unsel') { cart.seats.delete(+t.dataset.id); draw(); }
      else if (act === 'continue') {
        if (!cart.seats.size) return;
        if (!S.user) { location.hash = '#/login?next=' + encodeURIComponent(`#/checkout/${id}`); return; }
        location.hash = `#/checkout/${id}`;
      }
    });
    box.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset.act === 'stand') { e.preventDefault(); active = e.target.dataset.side; draw(); } });

    const refresh = async (notify) => { data = await api(`/matches/${id}/seats`); idx = sync(notify); draw(); };
    return {
      onSeats: (d) => { if (d.matchId === +id) refresh(true).catch(() => {}); },
      onMatch: (d) => { if (d.id === +id && d.status !== 'upcoming') refresh(false).catch(() => {}); },
      onReconnect: () => refresh(false).catch(() => {}),
    };
  };

  // ------------------------------------------------------------ CHECKOUT
  FQ.views.Checkout = async (box, { id }) => {
    if (!requireLogin()) return;
    const cart = S.cart;
    if (!cart || cart.matchId !== +id || !cart.seats.size) { location.hash = `#/book/${id}`; return; }
    const m = await api(`/matches/${id}`);
    const picked = [...cart.seats.values()];
    const total = picked.reduce((a, s) => a + s.price, 0);
    box.innerHTML = `<div class="ticket-wrap"><h2 style="margin-bottom:18px">Confirm Booking</h2>
      <div class="card stack">
        <div class="vs">${teamBlock(m.home)}<div class="mid">VS</div>${teamBlock(m.away)}</div>
        <div class="center muted">${esc(m.stadium.name)} • ${fDateTime(m.kickoff)}</div>
        <div class="tablewrap"><table><thead><tr><th>Stand</th><th>Seat</th><th style="text-align:right">Price</th></tr></thead><tbody>
          ${picked.map((s) => `<tr><td>${esc(s.stand)}</td><td><b>${esc(s.label)}</b></td><td style="text-align:right">${inr(s.price)}</td></tr>`).join('')}</tbody></table></div>
        <div class="total" style="margin-top:0"><span class="muted">Total amount</span><b>${inr(total)}</b></div>
        <div class="field"><label>Booking for</label><input value="${esc(S.user.name)} (${esc(S.user.email)})" disabled></div>
        <div class="field"><label>Payment method (demo)</label><select id="pay"><option>UPI (demo)</option><option>Card (demo)</option><option>Net banking (demo)</option></select>
          <p class="hint">No real payment is taken. This is a demonstration checkout.</p></div>
        <div id="err"></div>
        <div class="row"><a class="btn ghost" href="#/book/${id}">← Change seats</a><button class="btn primary right" id="pay-btn">Confirm &amp; Pay ${inr(total)}</button></div>
      </div></div>`;
    $('#pay-btn', box).onclick = async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Booking…';
      try {
        const b = await api(`/matches/${id}/book`, { method: 'POST', body: { seatIds: [...cart.seats.keys()] } });
        S.cart = null; S.justBooked = b.ref;
        location.hash = `#/ticket/${b.ref}`;
      } catch (err) {
        btn.disabled = false; btn.innerHTML = `Confirm &amp; Pay ${inr(total)}`;
        if (err.status === 409) { toast(err.message, 'err'); (err.data?.taken || []).forEach((t) => cart.seats.delete(t)); location.hash = `#/book/${id}`; }
        else $('#err', box).innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
      }
    };
  };

  // ------------------------------------------------------------ TICKET / MY TICKETS
  const seatSummary = (b) => (b.stands.length === 1 ? { stand: b.stands[0], seat: b.seats.map((s) => s.label).join(', ') } : { stand: 'Multiple stands', seat: b.seats.map((s) => `${s.stand.split(' ')[0]} ${s.label}`).join(', ') });

  FQ.views.Ticket = async (box, { ref }) => {
    if (!requireLogin()) return;
    const fresh = S.justBooked === ref; S.justBooked = null;
    let b = await api('/bookings/' + encodeURIComponent(ref));
    const draw = () => {
      const m = b.match; const ss = seatSummary(b);
      const stamp = b.status === 'cancelled' ? '<div class="stamp cancelled">CANCELLED</div>' : b.checkedIn ? '<div class="stamp used">CHECKED IN</div>' : '';
      const canCancel = b.status === 'confirmed' && !b.checkedIn && m.status === 'upcoming';
      box.innerHTML = `<div class="ticket-wrap">
        <div class="success-head">${fresh && b.status === 'confirmed' ? '<div class="check">✓</div><h2>Booking Confirmed</h2><p class="muted" style="margin-top:6px">Your seats are reserved. Show this QR code at the gate.</p>' : '<h2>Your Ticket</h2>'}</div>
        <div class="ticket">${stamp}
          <div class="ticket-top"><span>FOOTIQ MATCH TICKET</span><span>${esc(m.competition)}</span></div>
          <div class="ticket-body">
            <div><div class="k">Match</div><div class="v">${esc(m.home.name)} vs ${esc(m.away.name)}</div><div class="k" style="margin-top:4px;text-transform:none;letter-spacing:0;font-weight:600">${esc(m.stadium.name)}, ${esc(m.stadium.city)}</div></div>
            <div class="grid3"><div><div class="k">Date</div><div class="v">${fDateLong(m.kickoff)}</div></div><div><div class="k">Time</div><div class="v">${fTime(m.kickoff)}</div></div><div><div class="k">Paid</div><div class="v">${inr(b.total)}</div></div></div>
            <div class="grid3" style="grid-template-columns:1fr 1fr"><div><div class="k">Stand</div><div class="v">${esc(ss.stand)}</div></div><div><div class="k">Seat${b.seats.length > 1 ? 's' : ''}</div><div class="v">${esc(ss.seat)}</div></div></div>
          </div>
          <div class="ticket-tear"></div>
          <div class="ticket-qr">${qrSvg(b.qr)}<div class="k">DEMO QR TICKET</div><div class="bid">Booking ID: ${esc(b.ref)}</div></div>
        </div>
        <div class="row noprint" style="justify-content:center;margin-top:20px">
          <a class="btn primary" href="#/tickets">View My Bookings</a>
          <button class="btn" data-act="print">Print / Save PDF</button>
          ${canCancel ? '<button class="btn danger" data-act="cancel">Cancel booking</button>' : ''}</div></div>`;
    };
    draw();
    box.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (a === 'print') window.print();
      if (a === 'cancel' && confirm('Cancel this booking and release your seats?')) {
        try { b = await api(`/bookings/${encodeURIComponent(ref)}/cancel`, { method: 'POST' }); b = await api('/bookings/' + encodeURIComponent(ref)); toast('Booking cancelled. Your seats have been released.'); draw(); }
        catch (err) { toast(err.message, 'err'); }
      }
    });
  };

  FQ.views.Tickets = async (box) => {
    if (!requireLogin()) return;
    box.innerHTML = skeleton(2);
    const list = await api('/bookings/mine');
    box.innerHTML = `<div class="spread"><h2>My Tickets</h2><a class="btn ghost sm" href="#/matches">Book another match →</a></div>
      <div class="stack" style="margin-top:20px">${list.length ? list.map((b) => {
        const ss = seatSummary(b); const m = b.match;
        const pill = b.status === 'cancelled' ? '<span class="pill red">Cancelled</span>' : b.checkedIn ? '<span class="pill gold">Used</span>' : m.status === 'completed' ? '<span class="pill">Past</span>' : '<span class="pill green">Confirmed</span>';
        return `<a class="card bk-card" href="#/ticket/${esc(b.ref)}">
          <div><div class="row" style="gap:8px;margin-bottom:6px">${pill}<span class="muted tiny">${esc(b.ref)}</span></div>
            <h3 style="text-transform:none;font-family:inherit">${esc(m.home.name)} vs ${esc(m.away.name)}</h3>
            <div class="muted" style="margin-top:4px">${fDateTime(m.kickoff)} • ${esc(ss.stand)} • Seat ${esc(ss.seat)}</div></div>
          <div class="center"><b style="font-family:var(--display);font-size:26px">${inr(b.total)}</b><div class="muted tiny">View ticket →</div></div></a>`;
      }).join('') : '<div class="empty">You have not booked any tickets yet.<br><br><a class="btn primary" href="#/matches">Browse fixtures</a></div>'}</div>`;
  };

  // ------------------------------------------------------------ LIVE MATCH CENTRE
  const ICON = { goal: '⚽', yellow: '🟨', red: '🟥', sub: '🔄' };
  const ETITLE = { goal: 'Goal!', yellow: 'Yellow card', red: 'Red card', sub: 'Substitution' };

  function statBar(label, [h, a], m, pct) {
    const tot = h + a;
    const hp = tot ? (h / tot) * 100 : 50;
    return `<div class="stat"><div class="stat-head"><b>${h}${pct ? '%' : ''}</b><span>${label}</span><b>${a}${pct ? '%' : ''}</b></div>
      <div class="bar"><i class="h" style="width:calc(${hp}% - 2px);background:${esc(m.home.color)}"></i><i class="a" style="width:calc(${100 - hp}% - 2px);background:${esc(m.away.color)}"></i></div></div>`;
  }

  FQ.views.Live = async (box, { id }) => {
    box.innerHTML = skeleton(2);
    let m = await api('/matches/' + id);
    let tab = 'overview';
    let offset = m.clock.serverNow - Date.now();
    const seen = new Set(m.events.map((e) => e.id));

    const clockText = () => {
      if (m.status === 'upcoming') return `Kick-off ${fTime(m.kickoff)}`;
      if (m.status === 'completed') return 'FULL TIME';
      const c = m.clock;
      const sec = Math.min(c.base * 60 + (c.running ? Math.max(0, (Date.now() + offset - c.ref) / 1000) : 0), 120 * 60);
      const min = Math.floor(sec / 60);
      return `${c.running ? '' : (min === 45 ? 'HALF TIME • ' : 'PAUSED • ')}${min}'`;
    };

    const timeline = (newIds) => (m.events.length ? `<ol class="timeline">${m.events.map((e) => {
      const team = m[e.side];
      return `<li class="${e.type} ${newIds.has(e.id) ? 'new' : ''}"><span class="min">${e.minute}'</span>
        <div class="ev"><span class="ic">${ICON[e.type]}</span><div><b>${ETITLE[e.type]} — ${esc(team.name)}</b><span class="muted">${esc(e.text || e.player)}</span>${e.assister ? `<small class="assist-by">Assist · ${esc(e.assister)}</small>` : ''}</div></div></li>`;
    }).join('')}</ol>` : '<div class="empty">No match events yet.</div>');

    const draw = (newIds = new Set(), flash = false) => {
      const st = m.stats;
      const pillCls = m.status === 'live' ? 'pill live' : m.status === 'completed' ? 'pill' : 'pill gold';
      const pillTxt = m.status === 'live' ? 'LIVE' : m.status === 'completed' ? 'FULL TIME' : 'UPCOMING';
      const core = statBar('Possession', st.possession, m, true) + statBar('Pass accuracy', st.passAccuracy, m, true) + statBar('Shots', st.shots, m) + statBar('Shots on target', st.shotsOnTarget, m) + statBar('Corners', st.corners, m);
      let body;
      if (tab === 'statistics') body = `<div class="card"><h3>Match Statistics</h3>${core}${statBar('Fouls', st.fouls, m)}</div>`;
      else if (tab === 'commentary') body = `<div class="card"><h3 style="margin-bottom:6px">Commentary</h3>${m.events.length ? `<ul class="comm">${m.events.map((e) => `<li><span class="min">${e.minute}'</span><div>${ICON[e.type]} ${esc(e.text || e.player)}${e.assister ? `<small class="assist-by">Assist · ${esc(e.assister)}</small>` : ''}</div></li>`).join('')}</ul>` : '<div class="empty" style="margin-top:12px">Commentary will appear here once the match is under way.</div>'}</div>`;
      else body = `<div class="grid g2" style="align-items:start"><div class="card"><h3>Match Statistics</h3>${core}</div><div class="card"><h3 style="margin-bottom:10px">Match Timeline</h3>${timeline(newIds)}</div></div>`;
      box.innerHTML = `
        <div class="muted tiny" style="letter-spacing:.2em;font-weight:800;margin-bottom:10px">LIVE MATCH CENTRE</div>
        <section class="card mc-head ${m.status === 'completed' ? 'ft' : ''}">
          <div class="row" style="justify-content:center"><span class="${pillCls}">${pillTxt}</span><span class="muted">${esc(m.competition)} • ${esc(m.stadium.name)} • ${fDate(m.kickoff)}</span></div>
          <div class="scoreline">${teamBlock(m.home)}<div class="big ${flash ? 'flash' : ''}">${m.status === 'upcoming' ? 'v' : `${m.score.home} – ${m.score.away}`}</div>${teamBlock(m.away)}</div>
          <div class="clock" id="clock">${clockText()}</div>
          ${m.status === 'upcoming' ? `<a class="btn primary" style="margin-top:14px" href="#/book/${m.id}">Book Tickets</a>` : ''}
        </section>
        <div class="tabs" style="margin:20px 0">${['overview', 'statistics', 'commentary'].map((t) => `<button class="${tab === t ? 'on' : ''}" data-act="tab" data-t="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
        ${body}
        <p class="muted tiny" style="margin-top:14px">Demo data — not a real live match feed. Updates arrive in real time from the match operator.</p>`;
    };
    draw();
    box.addEventListener('click', (e) => { const b = e.target.closest('[data-act=tab]'); if (b) { tab = b.dataset.t; draw(); } });

    const timer = setInterval(() => { if (!box.isConnected) return clearInterval(timer); const el = $('#clock', box); if (el) el.textContent = clockText(); }, 1000);

    const apply = (d) => {
      const prev = m;
      m = d; offset = d.clock.serverNow - Date.now();
      const fresh = new Set(d.events.filter((e) => !seen.has(e.id)).map((e) => e.id));
      d.events.forEach((e) => seen.add(e.id));
      const goal = d.score.home !== prev.score.home || d.score.away !== prev.score.away;
      if (goal && d.score.home + d.score.away > prev.score.home + prev.score.away) {
        const scorer = d.events.find((e) => e.type === 'goal' && fresh.has(e.id));
        toast(`GOAL! ${scorer ? m[scorer.side].name : ''} ${d.score.home} – ${d.score.away}`, 'goal');
      } else if (d.events.some((e) => e.type === 'red' && fresh.has(e.id))) toast('Red card!', 'err');
      draw(fresh, goal);
    };
    return {
      onMatch: (d) => { if (d.id === +id) apply(d); },
      onReconnect: () => api('/matches/' + id).then(apply).catch(() => {}),
      destroy: () => clearInterval(timer),
    };
  };

  // ------------------------------------------------------------ STATISTICS (league table + results)
  FQ.views.Statistics = async (box) => {
    box.innerHTML = skeleton(2);
    const tableReq = api('/standings');
    const doneReq = api('/matches?status=completed');
    const liveReq = api('/matches?status=live');
    const leadersReq = api('/player-leaders').catch(async (err) => {
      if (err.status !== 404) throw err;
      const [completed, active] = await Promise.all([doneReq, liveReq]);
      const matches = await Promise.all(completed.concat(active).map((m) => api(`/matches/${m.id}`)));
      const maps = { scorers: new Map(), assisters: new Map(), cards: new Map() };
      const add = (bucket, person, team) => {
        if (!person || !team) return;
        const key = `${team.id}:${person}`;
        const current = bucket.get(key) || { name: person, teamId: team.id, team: team.name, short: team.short, color: team.color, value: 0 };
        current.value++; bucket.set(key, current);
      };
      matches.forEach((m) => m.events.forEach((e) => {
        const team = m[e.side];
        if (e.type === 'goal') { add(maps.scorers, e.player, team); add(maps.assisters, e.assister, team); }
        if (e.type === 'yellow' || e.type === 'red') add(maps.cards, e.player, team);
      }));
      const top = (bucket) => [...bucket.values()].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name)).slice(0, 5);
      return { scorers: top(maps.scorers), assisters: top(maps.assisters), cards: top(maps.cards), serverNeedsRestart: true };
    });
    const [table, done, live, leaders] = await Promise.all([tableReq, doneReq, liveReq, leadersReq]);
    const goals = done.concat(live).reduce((a, m) => a + m.score.home + m.score.away, 0);
    const leaderCard = (title, metric, rows, unit) => `<section class="card leader-card"><div class="card-title"><div><p class="eyebrow">PLAYER RANKINGS</p><h3>${title}</h3></div><span class="leader-icon" aria-hidden="true">${metric}</span></div>
      ${rows.length ? `<ol class="leader-list">${rows.map((p, i) => `<li><span class="leader-rank">${String(i + 1).padStart(2, '0')}</span>${crest({ name: p.team, short: p.short, color: p.color }, 'xs')}<span class="leader-name"><b>${esc(p.name)}</b><small>${esc(p.team)}</small></span><strong class="leader-value">${p.value}<small>${unit}</small></strong></li>`).join('')}</ol>` : '<div class="empty leader-empty">No player data yet.</div>'}</section>`;
    box.innerHTML = `<div class="stats-heading"><div><p class="eyebrow">SEASON SNAPSHOT</p><h2>League &amp; player stats</h2><p class="muted">Standings and player contributions from live and completed matches.</p></div><a class="btn ghost" href="#/matches">Browse fixtures <span aria-hidden="true">→</span></a></div>
      ${leaders.serverNeedsRestart ? '<div class="form-error stats-refresh-note">The app server is still running an older version. Restart FOOTIQ and refresh this page to enable assister tracking and saved league leader data.</div>' : ''}
      <div class="grid g3" style="margin:20px 0"><div class="card kpi"><div class="l">Matches completed</div><div class="n">${done.length}</div></div>
        <div class="card kpi"><div class="l">Goals scored</div><div class="n">${goals}</div></div>
        <div class="card kpi"><div class="l">Goals per match</div><div class="n">${done.length ? (goals / done.length).toFixed(2) : '–'}</div></div></div>
      <div class="grid g3 leader-grid">${leaderCard('Top scorers', '⚽', leaders.scorers, 'goals')}${leaderCard('Top assisters', '↗', leaders.assisters, 'assists')}${leaderCard('Most cards', '▤', leaders.cards, 'cards')}</div>
      <div class="grid g2" style="align-items:start">
        <div class="card"><h3 style="margin-bottom:12px">League table</h3><div class="tablewrap"><table><thead><tr><th>#</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr></thead><tbody>
          ${table.map((t, i) => `<tr><td>${i + 1}</td><td>${crest(t, 'xs')} ${esc(t.name)}</td><td>${t.p}</td><td>${t.w}</td><td>${t.d}</td><td>${t.l}</td><td>${t.gf - t.ga > 0 ? '+' : ''}${t.gf - t.ga}</td><td><b>${t.pts}</b></td></tr>`).join('')}</tbody></table></div>
          <p class="muted tiny" style="margin-top:8px">Includes any match currently in play.</p></div>
        <div class="card"><h3 style="margin-bottom:12px">Latest results</h3><div class="stack">${done.length ? done.map((m) => `<a class="row spread" href="#/live/${m.id}"><span>${esc(m.home.name)}</span><b style="font-family:var(--display);font-size:22px">${m.score.home} – ${m.score.away}</b><span>${esc(m.away.name)}</span></a>`).join('') : '<div class="empty">No results yet.</div>'}</div></div></div>`;
  };

  // ------------------------------------------------------------ LOGIN / REGISTER
  FQ.views.Login = async (box, _p, query) => {
    let mode = 'login';
    const home = (u) => (u.role === 'admin' ? '#/admin' : u.role === 'operator' ? '#/operator' : '#/');
    const draw = (err = '') => {
      box.innerHTML = `<div class="auth card"><h2 style="margin-bottom:16px">${mode === 'login' ? 'Log in' : 'Create account'}</h2>
        <div class="tabs" style="margin-bottom:18px"><button class="${mode === 'login' ? 'on' : ''}" data-m="login">Log in</button><button class="${mode === 'register' ? 'on' : ''}" data-m="register">Sign up</button></div>
        ${err ? `<div class="form-error">${esc(err)}</div>` : ''}
        <form id="f" novalidate>
          ${mode === 'register' ? '<div class="field"><label>Full name</label><input name="name" autocomplete="name" required></div>' : ''}
          <div class="field"><label>Email</label><input name="email" type="email" autocomplete="email" required></div>
          <div class="field"><label>Password</label><input name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required></div>
          <button class="btn primary block" type="submit">${mode === 'login' ? 'Log in' : 'Create account'}</button></form>
        ${mode === 'login' ? `<div style="margin-top:20px"><div class="muted tiny">Demo accounts (click to fill)</div><div class="demo-creds">
          <button class="btn sm" data-fill="fan@footiq.test|fan123">Fan</button><button class="btn sm" data-fill="operator@footiq.test|operator123">Operator</button><button class="btn sm" data-fill="admin@footiq.test|admin123">Admin</button></div></div>` : ''}</div>`;
    };
    draw();
    box.addEventListener('click', (e) => {
      const mb = e.target.closest('[data-m]'); if (mb) { mode = mb.dataset.m; draw(); }
      const fb = e.target.closest('[data-fill]');
      if (fb) { const [em, pw] = fb.dataset.fill.split('|'); $('[name=email]', box).value = em; $('[name=password]', box).value = pw; }
    });
    box.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try {
        const r = await api(mode === 'login' ? '/auth/login' : '/auth/register', { method: 'POST', body: f });
        setSession(r.token, r.user); renderChrome(); toast(`Welcome, ${r.user.name.split(' ')[0]}!`);
        const next = query.next;
        location.hash = next && next.startsWith('#/') && !next.startsWith('#/login') ? next : home(r.user);
      } catch (err) { draw(err.message); }
    });
  };

  // ------------------------------------------------------------ chrome (nav, user box)
  function renderChrome() {
    const h = location.hash || '#/';
    const items = [['#/', 'Home'], ['#/matches', 'Matches'], ['#/statistics', 'Statistics']];
    if (S.user) items.push(['#/tickets', 'My Tickets']);
    if (isStaff()) items.push(['#/operator', 'Operator']);
    if (S.user && S.user.role === 'admin') items.push(['#/admin', 'Admin']);
    $('#nav').innerHTML = items.map(([href, label]) => {
      const on = href === '#/' ? h === '#/' || h === '' : h.startsWith(href);
      return `<a href="${href}" class="${on ? 'active' : ''}">${label}</a>`;
    }).join('');
    $('#userbox').innerHTML = S.user
      ? `<span class="avatar" title="${esc(S.user.email)}">${esc(S.user.name[0].toUpperCase())}</span><span class="uname">${esc(S.user.name.split(' ')[0])} <span class="pill ${S.user.role === 'fan' ? '' : 'green'}">${S.user.role}</span></span><button class="btn sm ghost" id="logout">Log out</button>`
      : '<a class="btn sm primary" href="#/login">Login</a>';
    const lo = $('#logout');
    if (lo) lo.onclick = async () => { try { await api('/auth/logout', { method: 'POST' }); } catch (_) { /* ignore */ } setSession(null, null); S.cart = null; renderChrome(); location.hash = '#/'; toast('Logged out.'); };
  }
  FQ.renderChrome = renderChrome;

  // ------------------------------------------------------------ router
  const ROUTES = [
    [/^\/?$/, 'Home'], [/^\/matches$/, 'Matches'], [/^\/book\/(\d+)$/, 'Book', ['id']], [/^\/checkout\/(\d+)$/, 'Checkout', ['id']],
    [/^\/ticket\/([\w-]+)$/, 'Ticket', ['ref']], [/^\/tickets$/, 'Tickets'], [/^\/live\/(\d+)$/, 'Live', ['id']], [/^\/statistics$/, 'Statistics'],
    [/^\/login$/, 'Login'], [/^\/operator$/, 'Operator'], [/^\/admin(?:\/([\w-]+))?$/, 'Admin', ['tab']],
  ];

  async function navigate() {
    const myNav = ++S.navId;
    if (S.view && S.view.destroy) { try { S.view.destroy(); } catch (_) { /* ignore */ } }
    S.view = null;
    renderChrome();
    const [path, qs] = (location.hash || '#/').slice(1).split('?');
    const query = Object.fromEntries(new URLSearchParams(qs || ''));
    const app = $('#app');
    const box = document.createElement('div');
    app.replaceChildren(box);
    window.scrollTo(0, 0);
    for (const [re, name, keys = []] of ROUTES) {
      const mt = re.exec(path || '/');
      if (!mt) continue;
      const params = {}; keys.forEach((k, i) => { params[k] = mt[i + 1]; });
      try {
        const view = (await FQ.views[name](box, params, query)) || {};
        if (myNav !== S.navId) { if (view.destroy) view.destroy(); return; }
        S.view = view;
      } catch (err) {
        if (myNav !== S.navId) return;
        box.innerHTML = `<div class="empty"><h3>Something went wrong</h3><p style="margin:10px 0 16px">${esc(err.message)}</p><a class="btn" href="${esc(location.hash || '#/')}" onclick="location.reload()">Try again</a></div>`;
      }
      return;
    }
    box.innerHTML = '<div class="empty"><h3>Page not found</h3><p style="margin:10px 0 16px">That page does not exist.</p><a class="btn primary" href="#/">Go home</a></div>';
  }

  // ------------------------------------------------------------ realtime
  function connectStream() {
    const conn = $('#conn');
    let first = true;
    const es = new EventSource('/api/stream');
    es.addEventListener('hello', () => {
      conn.classList.add('on'); $('em', conn).textContent = 'Live updates on';
      if (!first && S.view && S.view.onReconnect) S.view.onReconnect();
      first = false;
    });
    es.addEventListener('match', (e) => { const d = JSON.parse(e.data); d.clock.clientAt = Date.now(); FQ.lastMatch = d; if (S.view && S.view.onMatch) S.view.onMatch(d); });
    es.addEventListener('seats', (e) => { if (S.view && S.view.onSeats) S.view.onSeats(JSON.parse(e.data)); });
    es.onerror = () => { conn.classList.remove('on'); $('em', conn).textContent = 'Reconnecting…'; };
  }

  FQ.start = () => {
    loadSession();
    window.addEventListener('hashchange', navigate);
    connectStream();
    navigate();
    if (S.token) api('/auth/me').then((r) => { S.user = r.user; renderChrome(); }).catch(() => {});
  };
})();
