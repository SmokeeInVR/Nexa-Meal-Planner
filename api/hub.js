// Vercel function for every /api/* route (vercel.json rewrites them here with ?route=...).
// Data lives in Neon (DATABASE_URL, set by the Neon integration); sign-in uses HOUSEHOLD_PASSCODE and HOUSEHOLD_MEMBERS.
// BACKUP_TOKEN opens the read-only export for the PC's weekly backup; FITNESS_ORIGINS lists the Fitness sites allowed to link.
import pg from 'pg';
import { createCore } from './_lib/core.js';
import { handleApi, send } from './_lib/http.js';
import { createPasscodeAuth } from './_lib/passcode-auth.js';
import { pgDatabase } from './_lib/pg-db.js';

let app = null;
function setup() {
  if (app) return app;
  if (!process.env.DATABASE_URL) return null;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, idleTimeoutMillis: 10_000 });
  let auth;
  const core = createCore({ db: pgDatabase(pool), nameOf: key => auth.nameOf(key) });
  auth = createPasscodeAuth({ passcode: process.env.HOUSEHOLD_PASSCODE, members: process.env.HOUSEHOLD_MEMBERS, core });
  app = {
    core, auth,
    backupToken: process.env.BACKUP_TOKEN,
    linkOrigins: String(process.env.FITNESS_ORIGINS || 'https://nexa-fitness.vercel.app').split(',').map(origin => origin.trim()).filter(Boolean),
  };
  return app;
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://local');
  const route = (url.searchParams.get('route') || url.pathname.replace(/^\/api\/?/, '')).replace(/^\/+|\/+$/g, '');
  const ready = setup();
  if (!ready) return send(res, 503, { error: 'The household database is not connected yet.' });
  return handleApi(route, req, res, ready);
}
