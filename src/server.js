'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, q, tx, hashPassword, checkPassword, getSecret, generateSeats } = require('./db');
const { seed } = require('./seed');
const { encode } = require('./qr');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SECRET = (seed(), getSecret());

// ---------------------------------------------------------------- tiny framework
class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const routes = [];
function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, opts, handler });
}
const get = (p, o, h) => route('GET', p, o, h);
const post = (p, o, h) => route('POST', p, o, h);
const put = (p, o, h) => route('PUT', p, o, h);
const del = (p, o, h) => route('DELETE', p, o, h);

const ROLES = { staff: ['operator', 'admin'], admin: ['admin'], user: ['fan', 'operator', 'admin'] };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { reject(new HttpError(413, 'Body too large')); req.destroy(); } });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_) { reject(new HttpError(400, 'Invalid JSON')); }
    });
  });
}

function authUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  const row = q.get('SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', token);
  return row ? { ...row, token } : null;
}

// ---------------------------------------------------------------- helpers
const int = (v, name, { min = -Infinity, max = Infinity, required = true } = {}) => {
  if ((v === undefined || v === null || v === '') && !required) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be an integer${Number.isFinite(min) ? ` between ${min} and ${max}` : ''}`);
  return n;
};
const str = (v, name, { max = 120, required = true } = {}) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s && required) throw new HttpError(400, `${name} is required`);
  if (s.length > max) throw new HttpError(400, `${name} is too long`);
  return s;
};

function minuteOf(m, now = Date.now()) {
  if (m.status === 'completed') return Math.max(m.clock_base, 90);
  if (m.status !== 'live') return 0;
  if (!m.clock_running) return m.clock_base;
  return Math.min(m.clock_base + Math.floor((now - m.clock_ref) / 60000), 120);
}

const MATCH_SQL = `
  SELECT m.*, h.name AS hname, h.short AS hshort, h.color AS hcolor,
         a.name AS aname, a.short AS ashort, a.color AS acolor,
         s.name AS sname, s.city AS scity
  FROM matches m
  JOIN teams h ON h.id = m.home_id
  JOIN teams a ON a.id = m.away_id
  JOIN stadiums s ON s.id = m.stadium_id`;

function shapeMatch(m) {
  const now = Date.now();
  const cap = q.get('SELECT COUNT(*) AS n FROM seats se JOIN stands st ON st.id = se.stand_id WHERE st.stadium_id = ?', m.stadium_id).n;
  const sold = q.get('SELECT COUNT(*) AS n FROM booking_seats WHERE match_id = ? AND active = 1', m.id).n;
  const minPrice = q.get('SELECT MIN(price) AS p FROM stands WHERE stadium_id = ?', m.stadium_id).p;
  return {
    id: m.id, competition: m.competition, status: m.status, kickoff: m.kickoff,
    stadium: { id: m.stadium_id, name: m.sname, city: m.scity },
    home: { id: m.home_id, name: m.hname, short: m.hshort, color: m.hcolor },
    away: { id: m.away_id, name: m.aname, short: m.ashort, color: m.acolor },
    score: { home: m.home_score, away: m.away_score },
    clock: { running: !!m.clock_running, base: m.clock_base, ref: m.clock_ref, serverNow: now },
    minute: minuteOf(m, now),
    tickets: { capacity: cap, sold, available: cap - sold, from: minPrice },
  };
}

function matchDetail(id) {
  const m = q.get(MATCH_SQL + ' WHERE m.id = ?', id);
  if (!m) return null;
  const out = shapeMatch(m);
  const st = q.get('SELECT * FROM match_stats WHERE match_id = ?', id) || {};
  out.stats = {
    possession: [st.poss_home ?? 50, st.poss_away ?? 50],
    passAccuracy: [st.pass_home ?? 0, st.pass_away ?? 0],
    shots: [st.shots_home ?? 0, st.shots_away ?? 0],
    shotsOnTarget: [st.sot_home ?? 0, st.sot_away ?? 0],
    corners: [st.corners_home ?? 0, st.corners_away ?? 0],
    fouls: [st.fouls_home ?? 0, st.fouls_away ?? 0],
  };
  out.events = q.all('SELECT e.id, e.minute, e.type, e.team_id AS teamId, e.player, e.assister, e.text, e.created_at AS createdAt FROM events e WHERE e.match_id = ? ORDER BY e.minute DESC, e.id DESC', id).map((e) => ({ ...e, side: e.teamId === m.home_id ? 'home' : 'away' }));
  return out;
}

// ---------------------------------------------------------------- realtime (Server-Sent Events)
const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) { try { c.write(msg); } catch (_) { clients.delete(c); } }
}
function pushMatch(id) { const d = matchDetail(id); if (d) broadcast('match', d); }
setInterval(() => { for (const c of clients) { try { c.write(': ping\n\n'); } catch (_) { clients.delete(c); } } }, 20000).unref();

get('/api/stream', { raw: true }, ({ req, res }) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 1500\n\nevent: hello\ndata: {}\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// ---------------------------------------------------------------- auth
function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  q.run('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)', token, userId, Date.now());
  return token;
}
post('/api/auth/login', (c) => {
  const email = str(c.body.email, 'Email').toLowerCase();
  const u = q.get('SELECT * FROM users WHERE email = ?', email);
  if (!u || !checkPassword(String(c.body.password || ''), u)) throw new HttpError(401, 'Incorrect email or password');
  return { token: newSession(u.id), user: { id: u.id, name: u.name, email: u.email, role: u.role } };
});
post('/api/auth/register', (c) => {
  const name = str(c.body.name, 'Name', { max: 60 });
  const email = str(c.body.email, 'Email', { max: 120 }).toLowerCase();
  const pw = String(c.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
  if (pw.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
  if (q.get('SELECT 1 AS x FROM users WHERE email = ?', email)) throw new HttpError(409, 'An account with this email already exists');
  const { salt, hash } = hashPassword(pw);
  const id = q.run('INSERT INTO users (name,email,pass_hash,salt,role) VALUES (?,?,?,?,?)', name, email, hash, salt, 'fan').lastInsertRowid;
  return { token: newSession(id), user: { id, name, email, role: 'fan' } };
});
get('/api/auth/me', { roles: ROLES.user }, (c) => ({ user: { id: c.user.id, name: c.user.name, email: c.user.email, role: c.user.role } }));
post('/api/auth/logout', { roles: ROLES.user }, (c) => { q.run('DELETE FROM sessions WHERE token = ?', c.user.token); return { ok: true }; });

// ---------------------------------------------------------------- public: matches
get('/api/home', () => {
  const rows = q.all(MATCH_SQL + ' ORDER BY m.kickoff');
  const all = rows.map(shapeMatch);
  const upcoming = all.filter((m) => m.status === 'upcoming');
  return { featured: upcoming[0] || null, upcoming: upcoming.slice(0, 4), live: all.filter((m) => m.status === 'live') };
});

get('/api/matches', (c) => {
  const status = c.query.status;
  const rows = q.all(MATCH_SQL + (['upcoming', 'live', 'completed'].includes(status) ? ' WHERE m.status = ?' : ' WHERE ? IS NULL OR 1=1') + ' ORDER BY m.kickoff ' + (status === 'completed' ? 'DESC' : 'ASC'), ['upcoming', 'live', 'completed'].includes(status) ? status : null);
  return rows.map(shapeMatch);
});

get('/api/matches/:id', (c) => {
  const d = matchDetail(int(c.params.id, 'id'));
  if (!d) throw new HttpError(404, 'Match not found');
  return d;
});

get('/api/matches/:id/players', (c) => {
  const m = q.get('SELECT home_id, away_id FROM matches WHERE id = ?', int(c.params.id, 'id'));
  if (!m) throw new HttpError(404, 'Match not found');
  const list = (tid) => q.all('SELECT id, name, number, position FROM players WHERE team_id = ? ORDER BY number', tid);
  return { home: list(m.home_id), away: list(m.away_id) };
});

get('/api/standings', () => {
  const rows = q.all("SELECT m.home_id, m.away_id, m.home_score hs, m.away_score aws FROM matches m WHERE m.status IN ('completed','live')");
  const table = new Map(q.all('SELECT id, name, short, color FROM teams').map((t) => [t.id, { ...t, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 }]));
  rows.forEach((r) => {
    const h = table.get(r.home_id); const a = table.get(r.away_id);
    h.p++; a.p++; h.gf += r.hs; h.ga += r.aws; a.gf += r.aws; a.ga += r.hs;
    if (r.hs > r.aws) { h.w++; a.l++; h.pts += 3; } else if (r.hs < r.aws) { a.w++; h.l++; a.pts += 3; } else { h.d++; a.d++; h.pts++; a.pts++; }
  });
  return [...table.values()].sort((x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf);
});

get('/api/player-leaders', () => {
  const aggregate = (expression, where) => q.all(`
    SELECT ${expression} AS name, e.team_id AS teamId, t.name AS team, t.short, t.color, COUNT(*) AS value
    FROM events e JOIN matches m ON m.id=e.match_id JOIN teams t ON t.id=e.team_id
    WHERE m.status IN ('completed','live') AND ${where}
    GROUP BY ${expression}, e.team_id ORDER BY value DESC, name COLLATE NOCASE LIMIT 5`);
  return {
    scorers: aggregate('e.player', "e.type='goal' AND e.player IS NOT NULL AND e.player<>''"),
    assisters: aggregate('e.assister', "e.type='goal' AND e.assister IS NOT NULL AND e.assister<>''"),
    cards: aggregate('e.player', "e.type IN ('yellow','red') AND e.player IS NOT NULL AND e.player<>''"),
  };
});

// ---------------------------------------------------------------- seats & booking
get('/api/matches/:id/seats', (c) => {
  const id = int(c.params.id, 'id');
  const m = q.get(MATCH_SQL + ' WHERE m.id = ?', id);
  if (!m) throw new HttpError(404, 'Match not found');
  const booked = new Set(q.all('SELECT seat_id FROM booking_seats WHERE match_id = ? AND active = 1', id).map((r) => r.seat_id));
  const mine = new Set();
  if (c.user) q.all('SELECT bs.seat_id FROM booking_seats bs JOIN bookings b ON b.id = bs.booking_id WHERE bs.match_id = ? AND bs.active = 1 AND b.user_id = ?', id, c.user.id).forEach((r) => mine.add(r.seat_id));
  const stands = q.all('SELECT * FROM stands WHERE stadium_id = ? ORDER BY CASE side WHEN \'west\' THEN 0 WHEN \'east\' THEN 1 WHEN \'north\' THEN 2 ELSE 3 END', m.stadium_id).map((st) => {
    const seats = q.all('SELECT id, label, row_label AS row, num FROM seats WHERE stand_id = ? ORDER BY row_label, num', st.id).map((s) => ({ ...s, status: mine.has(s.id) ? 'mine' : booked.has(s.id) ? 'booked' : 'available' }));
    return { id: st.id, name: st.name, side: st.side, rows: st.rows, cols: st.cols, price: st.price, available: seats.filter((s) => s.status === 'available').length, seats };
  });
  return { match: shapeMatch(m), stands, bookable: m.status === 'upcoming' };
});

function ticketPayload(ref) {
  const sig = crypto.createHmac('sha256', SECRET).update(ref).digest('hex').slice(0, 10);
  return `${ref}.${sig}`;
}

function bookingView(b, { withQr = true } = {}) {
  const m = q.get(MATCH_SQL + ' WHERE m.id = ?', b.match_id);
  const seats = q.all('SELECT bs.price, se.label, st.name AS stand FROM booking_seats bs JOIN seats se ON se.id = bs.seat_id JOIN stands st ON st.id = se.stand_id WHERE bs.booking_id = ? ORDER BY st.name, se.row_label, se.num', b.id);
  const payload = ticketPayload(b.ref);
  return {
    ref: b.ref, status: b.status, total: b.total, createdAt: b.created_at,
    checkedIn: !!b.checked_in, checkedInAt: b.checked_in_at,
    match: shapeMatch(m), seats,
    stands: [...new Set(seats.map((s) => s.stand))],
    qrText: payload,
    qr: withQr ? encode(payload) : undefined,
  };
}

post('/api/matches/:id/book', { roles: ROLES.user }, (c) => {
  const matchId = int(c.params.id, 'id');
  const ids = Array.isArray(c.body.seatIds) ? [...new Set(c.body.seatIds.map((x) => int(x, 'seatId')))] : [];
  if (!ids.length) throw new HttpError(400, 'Select at least one seat');
  if (ids.length > 6) throw new HttpError(400, 'You can book at most 6 seats at a time');

  const booking = (() => {
    try {
      return tx(() => {
        const m = q.get('SELECT * FROM matches WHERE id = ?', matchId);
        if (!m) throw new HttpError(404, 'Match not found');
        if (m.status !== 'upcoming') throw new HttpError(400, 'Booking is closed for this match');
        const seats = ids.map((sid) => {
          const s = q.get('SELECT se.id, se.label, st.name AS stand, st.price, st.stadium_id FROM seats se JOIN stands st ON st.id = se.stand_id WHERE se.id = ?', sid);
          if (!s || s.stadium_id !== m.stadium_id) throw new HttpError(400, 'Invalid seat for this match');
          return s;
        });
        const taken = seats.filter((s) => q.get('SELECT 1 AS x FROM booking_seats WHERE match_id = ? AND seat_id = ? AND active = 1', matchId, s.id));
        if (taken.length) throw new HttpError(409, `Sorry, ${taken.map((t) => `${t.stand} ${t.label}`).join(', ')} ${taken.length > 1 ? 'were' : 'was'} just booked by someone else`, { taken: taken.map((t) => t.id) });
        const year = new Date().getFullYear();
        const last = q.get("SELECT MAX(CAST(substr(ref, 10) AS INTEGER)) AS n FROM bookings WHERE ref LIKE ?", `FTQ-${year}-%`).n || 0;
        const ref = `FTQ-${year}-${String(last + 1).padStart(3, '0')}`;
        const total = seats.reduce((a, s) => a + s.price, 0);
        const bid = q.run('INSERT INTO bookings (ref, user_id, match_id, total) VALUES (?,?,?,?)', ref, c.user.id, matchId, total).lastInsertRowid;
        seats.forEach((s) => q.run('INSERT INTO booking_seats (booking_id, match_id, seat_id, price) VALUES (?,?,?,?)', bid, matchId, s.id, s.price));
        return q.get('SELECT * FROM bookings WHERE id = ?', bid);
      });
    } catch (e) {
      if (/UNIQUE constraint failed/.test(String(e.message))) throw new HttpError(409, 'One of those seats was just booked by someone else');
      throw e;
    }
  })();
  broadcast('seats', { matchId });
  return bookingView(booking);
});

get('/api/bookings/mine', { roles: ROLES.user }, (c) =>
  q.all('SELECT * FROM bookings WHERE user_id = ? ORDER BY id DESC', c.user.id).map((b) => bookingView(b, { withQr: false })));

get('/api/bookings/:ref', { roles: ROLES.user }, (c) => {
  const b = q.get('SELECT * FROM bookings WHERE ref = ?', c.params.ref);
  if (!b || (b.user_id !== c.user.id && c.user.role === 'fan')) throw new HttpError(404, 'Booking not found');
  return bookingView(b);
});

function cancelBooking(b) {
  if (b.status === 'cancelled') throw new HttpError(400, 'Booking is already cancelled');
  if (b.checked_in) throw new HttpError(400, 'This ticket has already been used for entry');
  tx(() => {
    q.run("UPDATE bookings SET status = 'cancelled' WHERE id = ?", b.id);
    q.run('UPDATE booking_seats SET active = 0 WHERE booking_id = ?', b.id);
  });
  broadcast('seats', { matchId: b.match_id });
}
post('/api/bookings/:ref/cancel', { roles: ROLES.user }, (c) => {
  const b = q.get('SELECT * FROM bookings WHERE ref = ?', c.params.ref);
  if (!b || (b.user_id !== c.user.id && c.user.role !== 'admin')) throw new HttpError(404, 'Booking not found');
  cancelBooking(b);
  return bookingView(q.get('SELECT * FROM bookings WHERE id = ?', b.id));
});

// QR ticket validation (operator / admin)
post('/api/tickets/validate', { roles: ROLES.staff }, (c) => {
  const code = str(c.body.code, 'Ticket code', { max: 80 });
  const [ref, sig] = code.split('.');
  const demoManualId = !sig; // demo convenience: allow typing the plain booking ID
  if (sig && ticketPayload(ref) !== code) return { valid: false, reason: 'Invalid QR signature — this ticket was not issued by FOOTIQ' };
  const b = q.get('SELECT * FROM bookings WHERE ref = ?', ref.toUpperCase());
  if (!b) return { valid: false, reason: 'No booking found for this code' };
  const view = bookingView(b, { withQr: false });
  if (b.status === 'cancelled') return { valid: false, reason: 'This booking was cancelled', booking: view };
  if (b.checked_in) return { valid: false, reason: `Already used for entry at ${b.checked_in_at}`, booking: view };
  if (c.body.checkIn !== false) {
    q.run("UPDATE bookings SET checked_in = 1, checked_in_at = datetime('now') WHERE id = ?", b.id);
    return { valid: true, checkedInNow: true, manual: demoManualId, booking: bookingView(q.get('SELECT * FROM bookings WHERE id = ?', b.id), { withQr: false }) };
  }
  return { valid: true, checkedInNow: false, manual: demoManualId, booking: view };
});

// ---------------------------------------------------------------- operator: live match control
const matchOr404 = (id) => { const m = q.get('SELECT * FROM matches WHERE id = ?', id); if (!m) throw new HttpError(404, 'Match not found'); return m; };
const requireLive = (m) => { if (m.status !== 'live') throw new HttpError(400, 'The match is not live. Start the match first.'); };

get('/api/operator/matches', { roles: ROLES.staff }, () => {
  const order = { live: 0, upcoming: 1, completed: 2 };
  return q.all(MATCH_SQL + ' ORDER BY m.kickoff').map(shapeMatch).sort((a, b) => order[a.status] - order[b.status]);
});

post('/api/operator/matches/:id/start', { roles: ROLES.staff }, (c) => {
  const m = matchOr404(int(c.params.id, 'id'));
  if (m.status !== 'upcoming') throw new HttpError(400, 'Only upcoming matches can be started');
  q.run("UPDATE matches SET status='live', home_score=0, away_score=0, clock_base=0, clock_ref=?, clock_running=1 WHERE id=?", Date.now(), m.id);
  if (!q.get('SELECT 1 AS x FROM match_stats WHERE match_id = ?', m.id)) q.run('INSERT INTO match_stats (match_id) VALUES (?)', m.id);
  pushMatch(m.id); broadcast('seats', { matchId: m.id });
  return matchDetail(m.id);
});

post('/api/operator/matches/:id/clock', { roles: ROLES.staff }, (c) => {
  const m = matchOr404(int(c.params.id, 'id'));
  requireLive(m);
  const minute = c.body.minute === undefined ? minuteOf(m) : int(c.body.minute, 'Minute', { min: 0, max: 130 });
  const running = c.body.running === undefined ? !!m.clock_running : !!c.body.running;
  q.run('UPDATE matches SET clock_base=?, clock_ref=?, clock_running=? WHERE id=?', minute, Date.now(), running ? 1 : 0, m.id);
  pushMatch(m.id);
  return matchDetail(m.id);
});

post('/api/operator/matches/:id/events', { roles: ROLES.staff }, (c) => {
  const m = matchOr404(int(c.params.id, 'id'));
  requireLive(m);
  const type = String(c.body.type);
  if (!['goal', 'yellow', 'red', 'sub'].includes(type)) throw new HttpError(400, 'Unknown event type');
  const teamId = int(c.body.teamId, 'Team');
  if (teamId !== m.home_id && teamId !== m.away_id) throw new HttpError(400, 'Team is not playing in this match');
  const team = q.get('SELECT name FROM teams WHERE id = ?', teamId).name;
  const player = str(c.body.player, 'Player name', { max: 60 });
  const playerIn = str(c.body.playerIn, 'Player on', { max: 60, required: false });
  const assister = type === 'goal' ? str(c.body.assister, 'Assister', { max: 60, required: false }) : null;
  if (assister && !q.get('SELECT id FROM players WHERE team_id=? AND name=?', teamId, assister)) throw new HttpError(400, 'Assister must be a player from the selected team');
  const minute = c.body.minute === undefined || c.body.minute === '' ? minuteOf(m) : int(c.body.minute, 'Minute', { min: 0, max: 130 });
  let text = str(c.body.text, 'Commentary', { max: 240, required: false });
  if (!text) {
    text = {
      goal: `GOAL! ${player} scores for ${team}${assister ? `, assisted by ${assister}` : ''}.`,
      yellow: `Yellow card for ${player} (${team}).`,
      red: `RED CARD! ${player} (${team}) is sent off.`,
      sub: `Substitution for ${team}: ${playerIn ? `${playerIn} replaces ${player}` : `${player} is replaced`}.`,
    }[type];
  }
  tx(() => {
    q.run('INSERT INTO events (match_id, minute, type, team_id, player, assister, text) VALUES (?,?,?,?,?,?,?)', m.id, minute, type, teamId, player, assister, text);
    if (type === 'goal') q.run(`UPDATE matches SET ${teamId === m.home_id ? 'home_score = home_score + 1' : 'away_score = away_score + 1'} WHERE id = ?`, m.id);
  });
  pushMatch(m.id);
  return matchDetail(m.id);
});

del('/api/operator/matches/:id/events/:eid', { roles: ROLES.staff }, (c) => {
  const m = matchOr404(int(c.params.id, 'id'));
  const e = q.get('SELECT * FROM events WHERE id = ? AND match_id = ?', int(c.params.eid, 'eid'), m.id);
  if (!e) throw new HttpError(404, 'Event not found');
  tx(() => {
    q.run('DELETE FROM events WHERE id = ?', e.id);
    if (e.type === 'goal') q.run(`UPDATE matches SET ${e.team_id === m.home_id ? 'home_score = MAX(home_score - 1, 0)' : 'away_score = MAX(away_score - 1, 0)'} WHERE id = ?`, m.id);
  });
  pushMatch(m.id);
  return matchDetail(m.id);
});

put('/api/operator/matches/:id/stats', { roles: ROLES.staff }, (c) => {
  const m = matchOr404(int(c.params.id, 'id'));
  const b = c.body;
  const cur = q.get('SELECT * FROM match_stats WHERE match_id = ?', m.id) || {};
  const pick = (key, def, max) => (b[key] === undefined ? (cur[key] ?? def) : int(b[key], key, { min: 0, max }));
  const possHome = pick('poss_home', 50, 100);
  const v = {
    poss_home: possHome, poss_away: 100 - possHome,
    pass_home: pick('pass_home', 0, 100), pass_away: pick('pass_away', 0, 100),
    shots_home: pick('shots_home', 0, 99), shots_away: pick('shots_away', 0, 99),
    sot_home: pick('sot_home', 0, 99), sot_away: pick('sot_away', 0, 99),
    corners_home: pick('corners_home', 0, 99), corners_away: pick('corners_away', 0, 99),
    fouls_home: pick('fouls_home', 0, 99), fouls_away: pick('fouls_away', 0, 99),
  };
  if (v.sot_home > v.shots_home || v.sot_away > v.shots_away) throw new HttpError(400, 'Shots on target cannot exceed total shots');
  const cols = Object.keys(v);
  q.run(`INSERT INTO match_stats (match_id, ${cols.join(',')}) VALUES (?, ${cols.map(() => '?').join(',')})
         ON CONFLICT(match_id) DO UPDATE SET ${cols.map((k) => `${k}=excluded.${k}`).join(',')}`, m.id, ...cols.map((k) => v[k]));
  pushMatch(m.id);
  return matchDetail(m.id);
});

post('/api/operator/matches/:id/finish', { roles: ROLES.staff }, (c) => {
  const m = matchOr404(int(c.params.id, 'id'));
  requireLive(m);
  q.run("UPDATE matches SET status='completed', clock_running=0, clock_base=MAX(?,90) WHERE id=?", minuteOf(m), m.id);
  pushMatch(m.id);
  return matchDetail(m.id);
});

// ---------------------------------------------------------------- admin
function crud(name, table, fields, { listSql, listParams = [], before, after } = {}) {
  const cols = fields.map((f) => f.key);
  const clean = (body, partial) => {
    const v = {};
    for (const f of fields) {
      if (body[f.key] === undefined) { if (!partial && f.required !== false && f.default === undefined) throw new HttpError(400, `${f.label || f.key} is required`); if (!partial && f.default !== undefined) v[f.key] = f.default; continue; }
      if (f.type === 'int') v[f.key] = int(body[f.key], f.label || f.key, { min: f.min, max: f.max, required: f.required !== false });
      else if (f.type === 'enum') { if (!f.values.includes(body[f.key])) throw new HttpError(400, `${f.label || f.key} is invalid`); v[f.key] = body[f.key]; }
      else v[f.key] = str(body[f.key], f.label || f.key, { max: f.max || 120, required: f.required !== false });
    }
    return v;
  };
  const wrap = (fn) => (c) => {
    try { return fn(c); } catch (e) {
      if (e instanceof HttpError) throw e;
      const msg = String(e.message || e);
      if (/UNIQUE/.test(msg)) throw new HttpError(409, 'That value already exists');
      if (/FOREIGN KEY/.test(msg)) throw new HttpError(409, 'This record is referenced by other data (bookings, matches or events) and cannot be removed');
      if (/CHECK/.test(msg)) throw new HttpError(400, 'One of the values is out of range');
      throw e;
    }
  };
  get(`/api/admin/${name}`, { roles: ROLES.admin }, wrap(() => q.all(listSql || `SELECT * FROM ${table} ORDER BY id`, ...listParams)));
  post(`/api/admin/${name}`, { roles: ROLES.admin }, wrap((c) => {
    const v = clean(c.body, false);
    if (before) before(v, null, c);
    const ks = Object.keys(v);
    const id = q.run(`INSERT INTO ${table} (${ks.join(',')}) VALUES (${ks.map(() => '?').join(',')})`, ...ks.map((k) => v[k])).lastInsertRowid;
    if (after) after(id, v, null);
    return q.get(`SELECT * FROM ${table} WHERE id = ?`, id);
  }));
  put(`/api/admin/${name}/:id`, { roles: ROLES.admin }, wrap((c) => {
    const id = int(c.params.id, 'id');
    const old = q.get(`SELECT * FROM ${table} WHERE id = ?`, id);
    if (!old) throw new HttpError(404, 'Not found');
    const v = clean(c.body, true);
    if (before) before(v, old, c);
    const ks = Object.keys(v);
    if (ks.length) q.run(`UPDATE ${table} SET ${ks.map((k) => `${k} = ?`).join(',')} WHERE id = ?`, ...ks.map((k) => v[k]), id);
    if (after) after(id, v, old);
    return q.get(`SELECT * FROM ${table} WHERE id = ?`, id);
  }));
  del(`/api/admin/${name}/:id`, { roles: ROLES.admin }, wrap((c) => {
    const id = int(c.params.id, 'id');
    if (before && before.onDelete) before.onDelete(id, c);
    const r = q.run(`DELETE FROM ${table} WHERE id = ?`, id);
    if (!r.changes) throw new HttpError(404, 'Not found');
    return { ok: true };
  }));
}

crud('teams', 'teams', [
  { key: 'name', label: 'Team name', type: 'str' },
  { key: 'short', label: 'Short code', type: 'str', max: 8 },
  { key: 'color', label: 'Colour', type: 'str', max: 9, default: '#19d38b' },
], { listSql: 'SELECT t.*, (SELECT COUNT(*) FROM players p WHERE p.team_id = t.id) AS players FROM teams t ORDER BY t.name' });

crud('players', 'players', [
  { key: 'team_id', label: 'Team', type: 'int' },
  { key: 'name', label: 'Player name', type: 'str', max: 60 },
  { key: 'number', label: 'Shirt number', type: 'int', min: 1, max: 99, required: false },
  { key: 'position', label: 'Position', type: 'str', max: 4, required: false },
], { listSql: 'SELECT p.*, t.name AS team FROM players p JOIN teams t ON t.id = p.team_id ORDER BY t.name, p.number' });

crud('matches', 'matches', [
  { key: 'home_id', label: 'Home team', type: 'int' },
  { key: 'away_id', label: 'Away team', type: 'int' },
  { key: 'stadium_id', label: 'Stadium', type: 'int' },
  { key: 'kickoff', label: 'Kick-off', type: 'str', max: 40 },
  { key: 'competition', label: 'Competition', type: 'str', max: 30, default: 'ISL' },
  { key: 'status', label: 'Status', type: 'enum', values: ['upcoming', 'live', 'completed'], default: 'upcoming' },
], {
  listSql: `SELECT m.id, m.kickoff, m.status, m.competition, m.home_id, m.away_id, m.stadium_id, m.home_score, m.away_score,
            h.name AS home, a.name AS away, s.name AS stadium,
            (SELECT COUNT(*) FROM booking_seats bs WHERE bs.match_id = m.id AND bs.active = 1) AS sold
            FROM matches m JOIN teams h ON h.id = m.home_id JOIN teams a ON a.id = m.away_id JOIN stadiums s ON s.id = m.stadium_id ORDER BY m.kickoff`,
  before: (v, old) => {
    const home = v.home_id ?? old?.home_id; const away = v.away_id ?? old?.away_id;
    if (home === away) throw new HttpError(400, 'Home and away teams must be different');
    if (v.kickoff && Number.isNaN(Date.parse(v.kickoff))) throw new HttpError(400, 'Kick-off must be a valid date/time');
  },
  after: (id) => { if (!q.get('SELECT 1 AS x FROM match_stats WHERE match_id = ?', id)) q.run('INSERT INTO match_stats (match_id) VALUES (?)', id); },
});

const standFields = [
  { key: 'stadium_id', label: 'Stadium', type: 'int' },
  { key: 'name', label: 'Stand name', type: 'str', max: 40 },
  { key: 'side', label: 'Side', type: 'enum', values: ['west', 'east', 'north', 'south'] },
  { key: 'rows', label: 'Rows', type: 'int', min: 1, max: 26 },
  { key: 'cols', label: 'Seats per row', type: 'int', min: 1, max: 30 },
  { key: 'price', label: 'Price (₹)', type: 'int', min: 0, max: 100000 },
];
const standBefore = (v, old) => {
  if (old && ((v.rows !== undefined && v.rows !== old.rows) || (v.cols !== undefined && v.cols !== old.cols))) {
    const used = q.get('SELECT COUNT(*) AS n FROM booking_seats bs JOIN seats se ON se.id = bs.seat_id WHERE se.stand_id = ?', old.id).n;
    if (used) throw new HttpError(409, 'Rows/seats cannot be changed once tickets exist for this stand. Change the price instead.');
  }
  const stadium = v.stadium_id ?? old?.stadium_id; const side = v.side ?? old?.side;
  const clash = q.get('SELECT id FROM stands WHERE stadium_id = ? AND side = ?' + (old ? ' AND id <> ?' : ''), ...(old ? [stadium, side, old.id] : [stadium, side]));
  if (clash) throw new HttpError(409, `This stadium already has a ${side} stand`);
};
standBefore.onDelete = (id) => {
  const used = q.get('SELECT COUNT(*) AS n FROM booking_seats bs JOIN seats se ON se.id = bs.seat_id WHERE se.stand_id = ?', id).n;
  if (used) throw new HttpError(409, 'This stand has bookings and cannot be deleted');
};
crud('stands', 'stands', standFields, {
  listSql: 'SELECT st.*, sd.name AS stadium, (SELECT COUNT(*) FROM seats WHERE stand_id = st.id) AS seats FROM stands st JOIN stadiums sd ON sd.id = st.stadium_id ORDER BY sd.name, st.side',
  before: standBefore,
  after: (id, v, old) => {
    if (!old) generateSeats(id, v.rows, v.cols);
    else if ((v.rows !== undefined && v.rows !== old.rows) || (v.cols !== undefined && v.cols !== old.cols)) {
      const cur = q.get('SELECT rows, cols FROM stands WHERE id = ?', id);
      q.run('DELETE FROM seats WHERE stand_id = ?', id);
      generateSeats(id, cur.rows, cur.cols);
    }
  },
});

const stadiumBefore = () => {};
stadiumBefore.onDelete = (id) => {
  const used = q.get('SELECT COUNT(*) AS n FROM matches WHERE stadium_id = ?', id).n;
  if (used) throw new HttpError(409, 'This stadium hosts matches and cannot be deleted');
};
crud('stadiums', 'stadiums', [
  { key: 'name', label: 'Stadium name', type: 'str' },
  { key: 'city', label: 'City', type: 'str', max: 60 },
], {
  listSql: `SELECT s.*, (SELECT COUNT(*) FROM stands WHERE stadium_id = s.id) AS stands,
            (SELECT COUNT(*) FROM seats se JOIN stands st ON st.id = se.stand_id WHERE st.stadium_id = s.id) AS capacity FROM stadiums s ORDER BY s.name`,
  before: stadiumBefore,
});

// users & roles
get('/api/admin/users', { roles: ROLES.admin }, () => q.all('SELECT u.id, u.name, u.email, u.role, u.created_at AS createdAt, (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id AND b.status = \'confirmed\') AS bookings FROM users u ORDER BY u.id DESC'));
post('/api/admin/users', { roles: ROLES.admin }, (c) => {
  const name = str(c.body.name, 'Name', { max: 60 });
  const email = str(c.body.email, 'Email').toLowerCase();
  const role = String(c.body.role || 'fan');
  if (!['fan', 'operator', 'admin'].includes(role)) throw new HttpError(400, 'Invalid role');
  const pw = String(c.body.password || '');
  if (pw.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
  if (q.get('SELECT 1 AS x FROM users WHERE email = ?', email)) throw new HttpError(409, 'Email already in use');
  const { salt, hash } = hashPassword(pw);
  const id = q.run('INSERT INTO users (name,email,pass_hash,salt,role) VALUES (?,?,?,?,?)', name, email, hash, salt, role).lastInsertRowid;
  return { id, name, email, role };
});
put('/api/admin/users/:id', { roles: ROLES.admin }, (c) => {
  const id = int(c.params.id, 'id');
  const u = q.get('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw new HttpError(404, 'User not found');
  if (c.body.role !== undefined) {
    if (!['fan', 'operator', 'admin'].includes(c.body.role)) throw new HttpError(400, 'Invalid role');
    if (id === c.user.id && c.body.role !== 'admin') throw new HttpError(400, 'You cannot remove your own admin access');
    q.run('UPDATE users SET role = ? WHERE id = ?', c.body.role, id);
  }
  if (c.body.name !== undefined) q.run('UPDATE users SET name = ? WHERE id = ?', str(c.body.name, 'Name', { max: 60 }), id);
  return { ok: true };
});
del('/api/admin/users/:id', { roles: ROLES.admin }, (c) => {
  const id = int(c.params.id, 'id');
  if (id === c.user.id) throw new HttpError(400, 'You cannot delete your own account');
  const hasBookings = q.get('SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND status = \'confirmed\'', id).n;
  if (hasBookings) throw new HttpError(409, 'This user has active bookings. Cancel them first.');
  if (!q.run('DELETE FROM users WHERE id = ?', id).changes) throw new HttpError(404, 'User not found');
  return { ok: true };
});

// bookings
get('/api/admin/bookings', { roles: ROLES.admin }, () =>
  q.all(`SELECT b.ref, b.total, b.status, b.created_at AS createdAt, b.checked_in AS checkedIn, u.name AS user, u.email,
         h.name || ' vs ' || a.name AS match, m.kickoff,
         (SELECT group_concat(st.name || ' ' || se.label, ', ') FROM booking_seats bs JOIN seats se ON se.id = bs.seat_id JOIN stands st ON st.id = se.stand_id WHERE bs.booking_id = b.id) AS seats
         FROM bookings b JOIN users u ON u.id = b.user_id JOIN matches m ON m.id = b.match_id
         JOIN teams h ON h.id = m.home_id JOIN teams a ON a.id = m.away_id ORDER BY b.id DESC`));
post('/api/admin/bookings/:ref/cancel', { roles: ROLES.admin }, (c) => {
  const b = q.get('SELECT * FROM bookings WHERE ref = ?', c.params.ref);
  if (!b) throw new HttpError(404, 'Booking not found');
  cancelBooking(b);
  return { ok: true };
});

get('/api/admin/overview', { roles: ROLES.admin }, () => {
  const one = (sql) => q.get(sql).n;
  const totals = {
    users: one('SELECT COUNT(*) AS n FROM users'),
    bookings: one("SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed'"),
    matches: one('SELECT COUNT(*) AS n FROM matches'),
    revenue: one("SELECT COALESCE(SUM(total),0) AS n FROM bookings WHERE status = 'confirmed'"),
    tickets: one('SELECT COUNT(*) AS n FROM booking_seats WHERE active = 1'),
    checkedIn: one("SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed' AND checked_in = 1"),
    cancelled: one("SELECT COUNT(*) AS n FROM bookings WHERE status = 'cancelled'"),
  };
  const byMatch = q.all(`SELECT m.id, h.short || ' v ' || a.short AS label, m.status,
      (SELECT COUNT(*) FROM booking_seats bs WHERE bs.match_id = m.id AND bs.active = 1) AS tickets,
      (SELECT COALESCE(SUM(bs.price),0) FROM booking_seats bs WHERE bs.match_id = m.id AND bs.active = 1) AS revenue,
      (SELECT COUNT(*) FROM seats se JOIN stands st ON st.id = se.stand_id WHERE st.stadium_id = m.stadium_id) AS capacity
      FROM matches m JOIN teams h ON h.id = m.home_id JOIN teams a ON a.id = m.away_id ORDER BY m.kickoff`);
  const byStand = q.all(`SELECT st.name AS stand, COUNT(*) AS tickets, SUM(bs.price) AS revenue
      FROM booking_seats bs JOIN seats se ON se.id = bs.seat_id JOIN stands st ON st.id = se.stand_id
      WHERE bs.active = 1 GROUP BY st.name ORDER BY revenue DESC`);
  const byDay = q.all(`SELECT substr(created_at,1,10) AS day, COUNT(*) AS bookings, SUM(total) AS revenue
      FROM bookings WHERE status = 'confirmed' GROUP BY day ORDER BY day DESC LIMIT 14`).reverse();
  return { totals, byMatch, byStand, byDay };
});

// ---------------------------------------------------------------- HTTP server
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, decodeURIComponent(url.pathname));
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const mt = r.re.exec(url.pathname);
      if (!mt) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(mt[i + 1]); });
      const user = authUser(req);
      if (r.opts.roles) {
        if (!user) throw new HttpError(401, 'Please log in to continue');
        if (!r.opts.roles.includes(user.role)) throw new HttpError(403, 'You do not have permission to do that');
      }
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const ctx = { req, res, params, query: Object.fromEntries(url.searchParams), body, user };
      const out = r.handler(ctx);
      if (r.opts.raw) return;
      return json(200, out);
    }
    json(404, { error: 'Not found' });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    json(500, { error: 'Something went wrong on the server' });
  }
});

server.listen(PORT, () => {
  console.log(`\n  FOOTIQ is running →  http://localhost:${PORT}\n`);
  console.log('  Demo logins:');
  console.log('    Fan       fan@footiq.test        / fan123');
  console.log('    Operator  operator@footiq.test   / operator123');
  console.log('    Admin     admin@footiq.test      / admin123\n');
});
