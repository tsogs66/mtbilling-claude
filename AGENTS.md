# AGENTS.md

## Project overview

MT-Billing is a MikroTik billing / PPPoE-IPoE management panel. It is a two-part
app in one repo:

- `server/` — Express + TypeScript API (run via `tsx`), SQLite (`better-sqlite3`),
  JWT auth. Entry point `server/src/index.ts`. DB schema + seed in `server/src/db.ts`.
  RouterOS API wrapper in `server/src/mikrotik.ts`.
- `client/` — React + Vite + TypeScript + Tailwind frontend. Pages in
  `client/src/pages`, shared shell in `client/src/components`.

Standard commands live in the root `package.json` and each sub-package's
`package.json`; the README documents setup and deployment. Prefer those instead
of duplicating commands here.

## Cursor Cloud specific instructions

- **Run everything from the repo root with `npm run dev`.** It uses
  `concurrently` to start the API (`http://localhost:4000`) and the Vite UI
  (`http://localhost:5173`) together. `concurrently` is a **root** dependency, so
  root deps must be installed (the update script / `npm install` handles this).
- **Vite proxies `/api` → `http://localhost:4000`.** The browser only talks to
  `:5173`; the API is not called directly from the frontend. If the API isn't
  running, the UI loads but data calls 500/fail.
- **Default login is `admin` / `admin123`** (seeded on first run; overridable via
  `server/.env`).
- **SQLite DB is auto-created and seeded** at `server/data/mt-billing.db` on first
  server boot. It is git-ignored. To reset sample data, stop the server and delete
  `server/data/*.db*`, then restart. Schema/seed changes only apply to a fresh DB
  (seed helpers are guarded by row-count checks and will not re-seed an existing DB).
- **Dashboard host stats are real**: `server/src/index.ts` reads the actual
  container/VM CPU, RAM and disk via `systeminformation`. Router/PPPoE numbers come
  from the seeded DB (or live RouterOS if a reachable router with API creds is added
  to the `routers` table).
- **No live MikroTik hardware is required.** `mikrotik.ts` falls back to DB data
  when a router is unconfigured/unreachable, so the whole panel is testable offline.
- **Port 4000 conflicts**: if the API fails with `EADDRINUSE`, an orphaned `tsx`
  server from a previous run is still bound to 4000. Find it with
  `ss -ltnp | grep :4000` and kill that specific PID before restarting.
- Verification commands: `npm run build` (client type-check + build),
  `npm run lint` (client eslint), `npm --prefix server run build` (server tsc).
