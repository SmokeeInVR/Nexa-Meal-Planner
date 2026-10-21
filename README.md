# Nexa-Meal-Planner

## Tests

No install needed (Node 22.5+ for the hub tests):

```bash
node tests/phase-a-smoke.mjs && node tests/phase-1-pantry-plan.mjs && node tests/phase-2-reconciliation.mjs && node tests/phase-3-recipe-box.mjs && node --no-warnings tests/hub-server.mjs && node --no-warnings tests/phase-4a-hub-sync.mjs
```

## Household hub (`hub/server.mjs`)

A small server with no dependencies that keeps the household's shared data on this PC and serves the app.
Opened anywhere else (Vercel, a saved file), the app finds no hub and stays phone-only.

- **Run:** `node --no-warnings hub/server.mjs`. It listens on `127.0.0.1:8790` only.
- **Data:** `%USERPROFILE%\NEXA-Data\meals\` holds `meals.sqlite`, `photos\` and `hub-config.json`. Override the folder with `MEALS_HUB_DATA` and the port with `MEALS_HUB_PORT`.
- **Sign-in modes** (`hub-config.json` → `auth.mode`):
  - `dev`: for testing on this PC. It refuses any request that came through Cloudflare. Use `/api/dev-login?as=<email>` to act as another member.
  - `access`: for phones, via Cloudflare Tunnel + Access. The hub verifies every request's Access token against `auth.teamDomain` and `auth.audience`, then checks the email against `auth.members`.
- **The app's only network calls** go through `hubRequest`, which allows same-origin `/api/` paths only. The page is also served with `connect-src 'self'`.
