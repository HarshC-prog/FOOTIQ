# FOOTIQ

FOOTIQ is a self-contained demo of an Indian Super League (ISL) ticketing and match-centre app. Fans can browse fixtures, select seats, book up to six tickets, and view QR tickets. Operators can update live matches and validate tickets. Admins can manage the demo data and review sales reports.

All teams, players, fixtures, results, and sales are fictional. Checkout is a demo and does not take payment. This app does not connect to a real match feed.

## Requirements and start-up

- Node.js 22.13 or newer (uses the built-in `node:sqlite` module)
- No third-party packages or database server are required

From the project directory, run:

```sh
npm start
```

Open <http://localhost:3000>. Set `PORT` to use a different port, for example `PORT=8080 npm start` (PowerShell: `$env:PORT=8080; npm start`).

On first start the app creates `data/footiq.db` and seeds it with sample data. Seeding only runs when the database has no users. To erase and recreate the sample database, stop the server, remove `data/footiq.db` and its SQLite sidecar files if present, then run `npm start` again. `npm run reset` runs the seed script, but does not erase an existing populated database; it will leave that database unchanged.

Set `FOOTIQ_DATA` to use a different directory for the SQLite database.

## Demo accounts

| Role | Email | Password | Main destination after login |
|---|---|---|---|
| Fan | `fan@footiq.test` | `fan123` | Home |
| Operator | `operator@footiq.test` | `operator123` | Match Operator |
| Admin | `admin@footiq.test` | `admin123` | Admin Dashboard |

Fans can also sign up from the login screen. New sign-ups receive the fan role. Admins can create users with any of the three roles. The login page includes buttons to fill in the demo credentials.

## App screens

The interface is a client-side app using hash routes:

| Screen | Route | What it does |
|---|---|---|
| Home | `#/` | Featured upcoming match, upcoming fixtures, live fixtures, and links to the rest of the app |
| Matches | `#/matches` | Browse upcoming, live, and completed fixtures; filter by team and view ticket availability and starting prices |
| Seat selection | `#/book/:id` | View seat availability by stand and select up to six seats for an upcoming match |
| Checkout | `#/checkout/:id` | Confirm the booking; no payment is collected |
| Ticket | `#/ticket/:ref` | View the booking, QR code, and print-friendly ticket; cancel an eligible booking |
| My Tickets | `#/tickets` | View your bookings and ticket status |
| Live Match Centre | `#/live/:id` | View score, match clock, events, statistics, and commentary |
| Statistics | `#/statistics` | View the table calculated from live and completed results and player event leaders |
| Match Operator | `#/operator` | Start, pause, and finish matches; update events and stats; validate tickets |
| Admin | `#/admin` and `#/admin/:tab` | Manage teams, players, fixtures, stadiums, stands, bookings, users, roles, and reports |

Booking and staff features require login. Only admins can open the admin area; operators and admins can use the operator dashboard and ticket validation.

## Try the demo

1. Browse Matches as a fan and open an upcoming fixture, such as Mumbai City FC vs Mohun Bagan SG.
2. Choose seats and continue to checkout. Log in as the demo fan if prompted, then confirm the demo booking.
3. Open the ticket to see its booking reference and QR code. The ticket can be printed from the browser.
4. Log in as the operator in another browser or private window. Open the live Bengaluru FC vs Kerala Blasters fixture and publish an event.
5. Keep that fixture's Live Match Centre open to see updates arrive without refreshing.
6. In the operator dashboard, validate the ticket using its QR text or booking reference. A successfully checked-in booking cannot be used again.
7. Log in as the admin to inspect bookings and analytics or manage the sample data.

## What the implementation enforces

- **Seat availability and booking:** SQLite stores seats and active booking seats. A partial unique index prevents an active duplicate booking for the same seat and match. Booking is performed in a `BEGIN IMMEDIATE` transaction, and cancellation releases seats. A booking can include at most six seats.
- **Authentication and roles:** Passwords are hashed with Node's `scrypt`; API routes check the user's fan, operator, or admin role. Sessions use random bearer tokens.
- **Tickets:** QR payloads contain a booking reference and an HMAC-SHA256 signature based on a per-install secret stored in the database. Staff can validate signed QR payloads; for this demo they can also enter a plain booking reference. Successful check-in prevents repeat entry and cancellation.
- **Live updates:** The server publishes match and seat changes over Server-Sent Events at `/api/stream`. Open clients receive match scores, events, stats, and seat availability updates.
- **Reports and statistics:** Standings, player leaders, and admin sales summaries are calculated from the SQLite data.

## Implementation

The original concept suggested React, TypeScript, Tailwind, Express, PostgreSQL, Socket.IO, and Python analytics. This version uses built-in Node.js modules and browser JavaScript, so it has no package installation step.

| Area | Implementation |
|---|---|
| Front end | Vanilla JavaScript single-page app in `public/app.js` and `public/staff.js`, with responsive styles in `public/style.css` |
| HTTP server and API | Node.js built-in `http` module and a small router in `src/server.js` |
| Database | SQLite through built-in `node:sqlite`; schema, password helpers, and seat generation are in `src/db.js` |
| Live updates | Server-Sent Events (`/api/stream`) |
| QR codes | Dependency-free encoder in `src/qr.js` |
| Sample data | `src/seed.js` |

## Project layout

```text
src/server.js   HTTP server, REST API, authentication, bookings, staff/admin routes, SSE
src/db.js       SQLite schema, transactions, password hashing, seat generation
src/seed.js     Fictional demo data and database seed script
src/qr.js       QR code generator
public/         Browser app, styles, and team logo assets
data/           SQLite database created when the app starts
```

## Main API groups

The browser app communicates with the local server through JSON endpoints:

- Public: `/api/home`, `/api/matches`, `/api/standings`, `/api/player-leaders`
- Authentication: `/api/auth/login`, `/api/auth/register`, `/api/auth/me`, `/api/auth/logout`
- Seats and bookings: `/api/matches/:id/seats`, `/api/matches/:id/book`, `/api/bookings/*`
- Operator: `/api/operator/*` and `/api/tickets/validate`
- Admin: `/api/admin/*`
- Live event stream: `/api/stream`

This is a local demonstration system: it has no payment processing, real ticket inventory, or official ISL data feed.
