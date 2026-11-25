'use strict';
// Seeds sample (fictional) demo data. Run with: npm run reset
const { db, q, tx, hashPassword, generateSeats } = require('./db');

function rng(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
const rand = rng(2026);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const FIRST = ['Arjun', 'Rohan', 'Vikram', 'Sandeep', 'Rahul', 'Imran', 'Deepak', 'Nikhil', 'Suresh', 'Anwar', 'Karan', 'Manish', 'Jeet', 'Lalit', 'Prabir', 'Sahal', 'Gurpreet', 'Yash', 'Amey', 'Joel', 'Naorem', 'Bipin', 'Subhasish', 'Brandon', 'Liston'];
const LAST = ['Singh', 'Sharma', 'Thapa', 'Das', 'Nair', 'Khan', 'Reddy', 'Gupta', 'Roy', 'Menon', 'Bose', 'Rai', 'Pillai', 'Ghosh', 'Mondal', 'Yadav', 'Chhetri', 'Kumar', 'Paul', 'Dias'];
const POS = ['GK', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'FW', 'FW', 'FW', 'GK', 'DF', 'MF', 'MF', 'FW'];

function seed() {
  const existing = q.get('SELECT COUNT(*) AS n FROM users').n;
  if (existing) return false;

  tx(() => {
    // --- users (demo accounts) -------------------------------------------------
    const addUser = (name, email, pw, role, createdAt) => {
      const { salt, hash } = hashPassword(pw);
      return q.run('INSERT INTO users (name,email,pass_hash,salt,role,created_at) VALUES (?,?,?,?,?,?)', name, email, hash, salt, role, createdAt || new Date().toISOString().slice(0, 19).replace('T', ' ')).lastInsertRowid;
    };
    addUser('Demo Fan', 'fan@footiq.test', 'fan123', 'fan');
    addUser('Match Operator', 'operator@footiq.test', 'operator123', 'operator');
    addUser('FOOTIQ Admin', 'admin@footiq.test', 'admin123', 'admin');

    // --- teams & players -------------------------------------------------------
    const teams = [
      ['Mumbai City FC', 'MCFC', '#5bc0ff'], ['Mohun Bagan SG', 'MBSG', '#d6264f'],
      ['Bengaluru FC', 'BFC', '#2f6bff'], ['Kerala Blasters', 'KBFC', '#ffc61a'],
      ['FC Goa', 'FCG', '#ff7a1a'], ['East Bengal', 'EBFC', '#e23b3b'],
      ['Chennaiyin FC', 'CFC', '#3b82f6'], ['NorthEast United', 'NEUFC', '#f97316'],
    ];
    const teamIds = teams.map(([n, s, c]) => q.run('INSERT INTO teams (name,short,color) VALUES (?,?,?)', n, s, c).lastInsertRowid);
    const used = new Set();
    teamIds.forEach((tid) => {
      for (let i = 0; i < POS.length; i++) {
        let name;
        do { name = `${pick(FIRST)} ${pick(LAST)}`; } while (used.has(name));
        used.add(name);
        q.run('INSERT INTO players (team_id,name,number,position) VALUES (?,?,?,?)', tid, name, i + 1, POS[i]);
      }
    });

    // --- stadiums & seats ------------------------------------------------------
    const stadiums = [
      ['Mumbai Football Arena', 'Mumbai'], ['Kolkata Salt Lake Arena', 'Kolkata'],
      ['Bengaluru Football Stadium', 'Bengaluru'], ['Kochi Nehru Stadium', 'Kochi'],
      ['Goa Fatorda Arena', 'Margao'], ['Chennai Marina Arena', 'Chennai'], ['Guwahati Indira Gandhi Arena', 'Guwahati'],
    ];
    const stadiumIds = stadiums.map(([n, c]) => {
      const sid = q.run('INSERT INTO stadiums (name,city) VALUES (?,?)', n, c).lastInsertRowid;
      [['West Stand', 'west', 4, 10, 500], ['East Stand', 'east', 4, 10, 400], ['North Stand', 'north', 3, 12, 300], ['South Stand', 'south', 3, 12, 300]].forEach(([name, side, rows, cols, price]) => {
        const stId = q.run('INSERT INTO stands (stadium_id,name,side,rows,cols,price) VALUES (?,?,?,?,?,?)', sid, name, side, rows, cols, price).lastInsertRowid;
        generateSeats(stId, rows, cols);
      });
      return sid;
    });

    // --- matches ---------------------------------------------------------------
    const T = (name) => teamIds[teams.findIndex((t) => t[0] === name)];
    const S = (name) => stadiumIds[stadiums.findIndex((s) => s[0] === name)];
    const now = Date.now();
    const addMatch = (home, away, stadium, kickoff, status = 'upcoming', hs = 0, as = 0) => q.run('INSERT INTO matches (home_id,away_id,stadium_id,kickoff,status,home_score,away_score) VALUES (?,?,?,?,?,?,?)', T(home), T(away), S(stadium), kickoff, status, hs, as).lastInsertRowid;
    const iso = (d, t) => `${d}T${t}:00+05:30`;

    const mUpcoming1 = addMatch('Mumbai City FC', 'Mohun Bagan SG', 'Mumbai Football Arena', iso('2026-11-28', '19:30'));
    const mLive = addMatch('Bengaluru FC', 'Kerala Blasters', 'Bengaluru Football Stadium', iso('2026-11-23', '19:30'), 'live', 2, 1);
    const mUpcoming2 = addMatch('FC Goa', 'East Bengal', 'Goa Fatorda Arena', iso('2026-11-29', '19:30'));
    const mUpcoming3 = addMatch('Chennaiyin FC', 'NorthEast United', 'Chennai Marina Arena', iso('2026-12-01', '19:30'));
    const mUpcoming4 = addMatch('Kerala Blasters', 'Mumbai City FC', 'Kochi Nehru Stadium', iso('2026-12-05', '17:00'));
    const mUpcoming5 = addMatch('Mohun Bagan SG', 'Bengaluru FC', 'Kolkata Salt Lake Arena', iso('2026-12-06', '19:30'));
    const done1 = addMatch('Mohun Bagan SG', 'FC Goa', 'Kolkata Salt Lake Arena', iso('2026-11-15', '19:30'), 'completed', 2, 0);
    const done2 = addMatch('Chennaiyin FC', 'East Bengal', 'Chennai Marina Arena', iso('2026-11-18', '19:30'), 'completed', 1, 1);
    const done3 = addMatch('Mumbai City FC', 'NorthEast United', 'Mumbai Football Arena', iso('2026-11-21', '19:30'), 'completed', 3, 1);

    // live match clock: 64' and running (set relative to "now")
    q.run('UPDATE matches SET clock_base=64, clock_ref=?, clock_running=1 WHERE id=?', now, mLive);

    // --- stats & events --------------------------------------------------------
    const stat = (id, v) => q.run(`INSERT INTO match_stats (match_id,poss_home,poss_away,pass_home,pass_away,shots_home,shots_away,sot_home,sot_away,corners_home,corners_away,fouls_home,fouls_away) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, ...v);
    [mUpcoming1, mUpcoming2, mUpcoming3, mUpcoming4, mUpcoming5].forEach((id) => stat(id, [50, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    stat(mLive, [58, 42, 84, 78, 12, 8, 6, 3, 5, 2, 9, 11]);
    stat(done1, [54, 46, 86, 80, 14, 7, 6, 2, 6, 3, 10, 12]);
    stat(done2, [49, 51, 79, 82, 9, 11, 3, 4, 4, 6, 13, 10]);
    stat(done3, [61, 39, 88, 74, 15, 6, 7, 2, 7, 2, 8, 14]);

    const player = (teamName) => q.get('SELECT name FROM players WHERE team_id=? AND position IN (\'FW\',\'MF\') ORDER BY RANDOM() LIMIT 1', T(teamName)).name;
    const ev = (mid, minute, type, teamName, text, assister = null, scorer = null) => {
      const p = scorer || player(teamName);
      const t = text ? text(p) : `${p}`;
      q.run('INSERT INTO events (match_id,minute,type,team_id,player,assister,text) VALUES (?,?,?,?,?,?,?)', mid, minute, type, T(teamName), p, assister, t);
    };
    const goal = (mid, m, team) => {
      const scorer = player(team);
      const assister = rand() < 0.72 ? q.get("SELECT name FROM players WHERE team_id=? AND position IN ('FW','MF') AND name<>? ORDER BY RANDOM() LIMIT 1", T(team), scorer)?.name || null : null;
      ev(mid, m, 'goal', team, (p) => `GOAL! ${p} finds the net for ${team}${assister ? `, assisted by ${assister}` : ''}.`, assister, scorer);
    };
    goal(mLive, 31, 'Bengaluru FC'); goal(mLive, 44, 'Kerala Blasters');
    ev(mLive, 52, 'yellow', 'Kerala Blasters', (p) => `Yellow card for ${p} after a late challenge.`);
    goal(mLive, 64, 'Bengaluru FC');
    goal(done1, 22, 'Mohun Bagan SG'); goal(done1, 71, 'Mohun Bagan SG');
    goal(done2, 12, 'Chennaiyin FC'); goal(done2, 78, 'East Bengal');
    goal(done3, 9, 'Mumbai City FC'); goal(done3, 40, 'NorthEast United'); goal(done3, 58, 'Mumbai City FC'); goal(done3, 83, 'Mumbai City FC');

    // --- sample fans & historical bookings so analytics are not empty -------------
    const fans = [];
    for (let i = 0; i < 30; i++) {
      const days = Math.floor(rand() * 20);
      const d = new Date(now - days * 86400000 - rand() * 86400000).toISOString().slice(0, 19).replace('T', ' ');
      fans.push(addUser(`${pick(FIRST)} ${pick(LAST)}`, `fan${i + 1}@sample.footiq.test`, 'sample-fan', 'fan', d));
    }
    const stadiumSeats = (matchId) => q.all('SELECT se.id, se.label, st.name AS stand, st.price FROM seats se JOIN stands st ON st.id=se.stand_id WHERE st.stadium_id=(SELECT stadium_id FROM matches WHERE id=?)', matchId);
    let seq = 0;
    const bookRandom = (matchId, count, protectedFn) => {
      const free = stadiumSeats(matchId).filter((s) => !protectedFn || !protectedFn(s));
      for (let b = 0; b < count && free.length > 3; b++) {
        const n = 1 + Math.floor(rand() * 3);
        const chosen = [];
        const startIdx = Math.floor(rand() * (free.length - n));
        for (let i = 0; i < n; i++) chosen.push(free[startIdx + i]);
        chosen.forEach((c) => free.splice(free.indexOf(c), 1));
        seq += 1;
        const days = Math.floor(rand() * 14);
        const when = new Date(now - days * 86400000 - rand() * 80000000).toISOString().slice(0, 19).replace('T', ' ');
        const total = chosen.reduce((s, c) => s + c.price, 0);
        const bid = q.run('INSERT INTO bookings (ref,user_id,match_id,total,created_at) VALUES (?,?,?,?,?)', `FTQ-2026-${String(seq).padStart(3, '0')}`, pick(fans), matchId, total, when).lastInsertRowid;
        chosen.forEach((c) => q.run('INSERT INTO booking_seats (booking_id,match_id,seat_id,price) VALUES (?,?,?,?)', bid, matchId, c.id, c.price));
      }
    };
    // keep West Stand A1-A6 free on the featured match so the demo flow always has seats to pick
    bookRandom(mUpcoming1, 14, (s) => s.stand === 'West Stand' && /^A[1-6]$/.test(s.label));
    bookRandom(mUpcoming2, 9); bookRandom(mUpcoming3, 6); bookRandom(mUpcoming4, 8); bookRandom(mUpcoming5, 4);
    bookRandom(mLive, 18); bookRandom(done1, 16); bookRandom(done2, 10); bookRandom(done3, 14);
  });
  return true;
}

module.exports = { seed };

if (require.main === module) {
  const fs = require('fs');
  const { DB_FILE } = require('./db');
  db.close();
  ['', '-wal', '-shm'].forEach((x) => { try { fs.unlinkSync(DB_FILE + x); } catch (_) { /* none */ } });
  // re-require fresh connection
  delete require.cache[require.resolve('./db')];
  delete require.cache[require.resolve('./seed')];
  const fresh = require('./seed');
  fresh.seed();
  console.log('Database reset and seeded with sample data.');
}
