# Nexa-Meal-Planner

## Tests

No install needed (Node 22.5+ for the hub tests):

```bash
node tests/phase-a-smoke.mjs && node tests/phase-1-pantry-plan.mjs && node tests/phase-2-reconciliation.mjs && node tests/phase-3-recipe-box.mjs && node --no-warnings tests/hub-server.mjs && node --no-warnings tests/phase-4a-hub-sync.mjs
```

## Vercel + Neon (the household's shared copy)

`api/hub.js` handles every `/api/*` route on Vercel (`vercel.json` rewrites them) and keeps the data in Neon Postgres.
Phones sign in once with a household passcode and pick their name. The signed-in cookie lasts 90 days, and changing the passcode signs every phone out.

Vercel environment variables:
- `DATABASE_URL`: set by the Neon integration.
- `HOUSEHOLD_PASSCODE`: at least 8 characters; several words is best. After 10 wrong tries from one address, that address is locked out for 15 minutes.
- `HOUSEHOLD_MEMBERS`: comma-separated names, e.g. `Marcel, <name>`.

Tests run the same SQL on PGlite (Postgres compiled to WebAssembly): `npm install`, then `npm test`.

## Household hub on this PC (`hub/server.mjs`, alternative)

A small server with no dependencies that keeps the household's shared data on this PC and serves the app.
Opened anywhere else (Vercel, a saved file), the app finds no hub and stays phone-only.

- **Run:** `node --no-warnings hub/server.mjs`. It listens on `127.0.0.1:8790` only.
- **Data:** `%USERPROFILE%\NEXA-Data\meals\` holds `meals.sqlite`, `photos\` and `hub-config.json`. Override the folder with `MEALS_HUB_DATA` and the port with `MEALS_HUB_PORT`.
- **Sign-in modes** (`hub-config.json` → `auth.mode`):
  - `dev`: for testing on this PC. It refuses any request that came through Cloudflare. Use `/api/dev-login?as=<email>` to act as another member.
  - `access`: for phones, via Cloudflare Tunnel + Access. The hub verifies every request's Access token against `auth.teamDomain` and `auth.audience`, then checks the email against `auth.members`.
- **The app's only network calls** go through `hubRequest`, which allows same-origin `/api/` paths only. The page is also served with `connect-src 'self'`.
