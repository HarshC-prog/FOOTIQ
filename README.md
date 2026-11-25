# FOOTIQ — ISL ticket booking, live match centre & stats (demo app)

A complete, runnable implementation of the FOOTIQ wireframe: all seven screens, one connected demo journey,
real seat locking, QR tickets, real-time match updates and role-based access.

## Run it

Requires **Node.js 22.13 or newer** (https://nodejs.org). There is nothing to install — no `npm install`, no database server.

```bash
cd footiq
npm start
# → http://localhost:3000     (use PORT=8080 npm start to change the port)
```

The first start creates `data/footiq.db` and fills it with sample (fictional) ISL data.
`npm run reset` wipes it and re-seeds.

### Demo accounts

| Role     | Email                  | Password      | Lands on            |
|----------|------------------------|---------------|---------------------|
| Fan      | fan@footiq.test        | fan123        | Home / My Tickets   |
| Operator | operator@footiq.test   | operator123   | Match Operator      |
| Admin    | admin@footiq.test      | admin123      | Admin Dashboard     |

Anyone can also create a fan account from **Login → Sign up**. (Admins can create operator/admin users.)
The login page has one-click buttons to fill the demo credentials.

## The screens (wireframe → app)

| # | Wireframe screen              | Route                    | Notes |
|---|-------------------------------|--------------------------|-------|
| 1 | Home                          | `#/`                     | Featured match, upcoming fixtures, live match card, booking entry point |
| 2 | Matches / fixtures            | `#/matches`              | Upcoming / Live / Completed tabs, team filter, availability and "from ₹" price |
| 3 | Seat selection & booking      | `#/book/:id` → `#/checkout/:id` | Clickable stadium map (4 stands), per-seat status from the database, price total, up to 6 seats |
| 4 | Booking confirmation / tickets| `#/ticket/:ref`, `#/tickets` | Unique booking ID (`FTQ-2026-###`), scannable QR, print/PDF, cancel, history |
| 5 | Live Match Centre & stats     | `#/live/:id`             | Score, ticking match clock, timeline, stat bars, commentary — updates instantly |
| 6 | Match Operator dashboard      | `#/operator`             | Start/pause/finish, goals/cards/subs, commentary, team stats, undo, ticket validation |
| 7 | Admin dashboard               | `#/admin`                | KPIs, CRUD for teams, players, fixtures, stadiums, stands (auto-generates seats), bookings, users & roles, sales analytics |

Extra: `#/statistics` (league table computed from results) — linked from the home page footer cards.

## Suggested presentation flow

1. Open **Home** as a fan → *Explore Matches* → **Book Now** on Mumbai City FC vs Mohun Bagan SG.
2. Pick a seat (e.g. West Stand A3) → *Continue to Booking* → log in as the demo fan → *Confirm & Pay*.
3. The **ticket** appears with its QR code.
4. In a second window (or private tab) log in as **operator** → open the live match (Bengaluru FC vs Kerala Blasters).
5. In a third window open **Live Match Centre** (`#/live/2`), then publish a goal from the operator window — the score, timeline and toast update immediately, with no refresh.
6. Operator → *Ticket validation* → paste the QR text (or booking ID) → "Valid ticket — entry granted". Scanning it again says "Already used".
7. Log in as **admin** → bookings, revenue and analytics have already moved.

Try the double-booking protection: open the same match in two browsers, select the same seat in both, and confirm in the second after the first has paid — the second user is told the seat was just taken and returned to the map.

## What is actually enforced (not just drawn)

- **Seat status lives in the database.** `booking_seats` has a partial unique index on `(match_id, seat_id) WHERE active = 1`, and each booking runs inside a `BEGIN IMMEDIATE` transaction, so two users can never hold the same seat — even if requests arrive simultaneously. Cancelling releases the seat.
- **Role-based access** is checked on every API call (fan / operator / admin). Passwords are hashed with scrypt; sessions are random tokens.
- **QR tickets** carry `bookingID.signature` (HMAC-SHA256 with a per-install secret), so forged codes are rejected. The QR encoder is built in (no libraries).
- **Real-time updates** are pushed to every open browser (score, events, stats, clock, seat availability).

## Deviations from the suggested tech stack — please read

The wireframe suggests React + TypeScript, Tailwind, Express, PostgreSQL, Socket.IO and Python. This build was produced in an environment
with no package-registry access, so none of those could be installed. To still ship something that works the moment you unzip it, it uses:

| Suggested             | What this app uses                                  | Same behaviour? |
|-----------------------|-----------------------------------------------------|-----------------|
| React + TypeScript    | Vanilla JS single-page app (`public/app.js`, `staff.js`) | Same seven screens |
| Tailwind CSS          | Hand-written responsive CSS (`public/style.css`)    | Yes, works on phones |
| Node + Express        | Node's built-in `http` with a small router (`src/server.js`) | Same REST design |
| PostgreSQL            | SQLite via Node's built-in `node:sqlite` (`data/footiq.db`) | Same relational schema and constraints |
| Socket.IO             | Server-Sent Events (`/api/stream`)                  | Same push updates |
| Python analytics      | Analytics are SQL queries in the admin API          | Optional item skipped |

The schema (`src/db.js`) is plain relational SQL, so moving to PostgreSQL later is mostly a matter of swapping the driver and
changing `INTEGER PRIMARY KEY` to `SERIAL`/identity columns, `datetime('now')` to `now()`, and the transaction call. Everything
that matters for the booking guarantee (the partial unique index) also exists in PostgreSQL.

## Project layout

```
src/server.js   HTTP server, REST API, auth, booking, operator + admin endpoints, SSE
src/db.js       Schema, transactions, password hashing
src/seed.js     Sample teams, players, stadiums, matches, events, bookings
src/qr.js       Dependency-free QR code generator
public/         index.html, style.css, app.js (fan screens), staff.js (operator + admin)
data/           SQLite database (created on first run)
```

All names, players, scores and sales figures are fictional sample data — this is not a real ISL match feed or ticketing system,
and no real payments are taken.
