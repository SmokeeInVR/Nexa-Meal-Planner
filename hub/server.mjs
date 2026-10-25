#!/usr/bin/env node
// Meals hub: the household's shared Meal Planner data, kept on this PC (the self-hosted alternative
// to the Vercel + Neon deployment; both run the same sync core in api/_lib).
// It listens on 127.0.0.1 only; phones reach it through Cloudflare Tunnel + Access (mode "access"),
// or, while testing on this PC, directly (mode "dev", which refuses anything that came through Cloudflare).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createCore } from '../api/_lib/core.js';
import { handleApi, SECURITY_HEADERS, send } from '../api/_lib/http.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The app may only talk to this hub (connect-src 'self'); links to videos are plain navigation.
const APP_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export const DEFAULT_CONFIG = {
  port: 8790,
  auth: {
    mode: 'dev',
    members: [{ email: 'you@dev.local', name: 'You' }, { email: 'partner@dev.local', name: 'Partner' }],
    teamDomain: '',
    audience: '',
  },
};

// SQLite adapter for the sync core: $1 placeholders become ?1.
export function sqliteDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const statements = new Map();
  const run = (sql, params) => {
    let statement = statements.get(sql);
    if (!statement) { statement = db.prepare(sql.replace(/\$(\d+)/g, '?$1')); statements.set(sql, statement); }
    return statement.all(...params);
  };
  let queue = Promise.resolve();
  return {
    blobType: 'BLOB',
    raw: db,
    async query(sql, params) { return run(sql, params); },
    // One transaction at a time on this connection.
    transaction(fn) {
      const next = queue.then(async () => {
        db.exec('BEGIN IMMEDIATE');
        try { const result = await fn({ query: async (sql, params) => run(sql, params) }); db.exec('COMMIT'); return result; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      });
      queue = next.catch(() => {});
      return next;
    },
  };
}

function readCookie(req, name) {
  const match = String(req.headers.cookie || '').split(/;\s*/).find(part => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}

export function createAuth(config, { now = () => Date.now(), fetchCerts } = {}) {
  const members = new Map((config.members || []).map(member => {
    const email = String(member.email).trim().toLowerCase();
    return [email, { key: email, email, name: String(member.name || email) }];
  }));
  let certs = null, certsAt = 0;
  async function loadKeys(force) {
    if (!force && certs && now() - certsAt < 3600_000) return certs;
    const jwks = fetchCerts ? await fetchCerts() : await fetch(`https://${config.teamDomain}/cdn-cgi/access/certs`).then(res => {
      if (!res.ok) throw new Error(`Cloudflare certs request failed: ${res.status}`);
      return res.json();
    });
    certs = Array.isArray(jwks?.keys) ? jwks.keys : [];
    certsAt = now();
    return certs;
  }
  // Cloudflare Access signs a JWT for every request it lets through; check it rather than trusting headers.
  async function verifyAccessToken(token) {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    let header, payload;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    } catch { return null; }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
    let jwk = (await loadKeys(false)).find(key => key.kid === header.kid);
    if (!jwk) jwk = (await loadKeys(true)).find(key => key.kid === header.kid);
    if (!jwk) return null;
    const signed = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
      crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    if (!signed) return null;
    const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audience.includes(config.audience)) return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now()) return null;
    if (payload.iss !== `https://${config.teamDomain}`) return null;
    return typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
  }
  return {
    members: () => [...members.values()],
    nameOf: key => members.get(key)?.name || key,
    async identify(req) {
      if (config.mode === 'access') {
        const token = req.headers['cf-access-jwt-assertion'] || readCookie(req, 'CF_Authorization');
        if (!token) return { status: 401, error: 'Sign in through Cloudflare Access first.' };
        const email = await verifyAccessToken(token);
        if (!email) return { status: 401, error: 'Your sign-in could not be verified. Reload to sign in again.' };
        const member = members.get(email);
        return member ? { member } : { status: 403, error: 'This account is not part of the household.' };
      }
      if (['cf-ray', 'cf-connecting-ip', 'cf-access-jwt-assertion'].some(name => req.headers[name])) {
        return { status: 403, error: 'Dev mode only answers requests made on this PC.' };
      }
      const asked = String(req.headers['x-hub-dev-user'] || readCookie(req, 'hub_dev_user')).trim().toLowerCase();
      const member = asked ? members.get(asked) : [...members.values()][0];
      return member ? { member } : { status: 403, error: 'Unknown dev user.' };
    },
  };
}

export function createHub({ dataDir, appFile = path.join(HERE, '..', 'index.html'), auth: authConfig, now = () => new Date(), fetchCerts }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = sqliteDatabase(path.join(dataDir, 'meals.sqlite'));
  const auth = createAuth(authConfig, { now: () => now().getTime(), fetchCerts });
  const core = createCore({ db, nameOf: auth.nameOf, now });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://hub.local');
    const route = url.pathname;
    if (route.startsWith('/api/')) {
      const sub = route.slice('/api/'.length);
      if (sub === 'dev-login' && req.method === 'GET' && authConfig.mode !== 'access') {
        const who = await auth.identify(req);
        if (!who.member) return send(res, who.status, { error: who.error });
        const email = String(url.searchParams.get('as') || '').toLowerCase();
        if (!auth.members().some(entry => entry.email === email)) return send(res, 400, { error: 'Unknown dev user.' });
        res.writeHead(302, { Location: '/', 'Set-Cookie': `hub_dev_user=${encodeURIComponent(email)}; Path=/; HttpOnly; SameSite=Strict`, ...SECURITY_HEADERS });
        return res.end();
      }
      return handleApi(sub, req, res, { core, auth });
    }
    const who = await auth.identify(req);
    if (!who.member) return send(res, who.status, { error: who.error });
    if ((route === '/' || route === '/index.html') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Security-Policy': APP_CSP, ...SECURITY_HEADERS });
      return res.end(fs.readFileSync(appFile));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    return res.end('Not found');
  }

  return { handle, core, db, server: http.createServer(handle), close: () => db.raw.close() };
}

function loadConfig(dataDir) {
  const file = path.join(dataDir, 'hub-config.json');
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (config.auth?.mode === 'access' && (!config.auth.teamDomain || !config.auth.audience || !config.auth.members?.length)) {
    throw new Error(`Access mode needs auth.teamDomain, auth.audience and auth.members in ${file}`);
  }
  return config;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.MEALS_HUB_DATA || path.join(os.homedir(), 'NEXA-Data', 'meals');
  fs.mkdirSync(dataDir, { recursive: true });
  const config = loadConfig(dataDir);
  const port = Number(process.env.MEALS_HUB_PORT || config.port || 8790);
  const hub = createHub({ dataDir, auth: config.auth });
  hub.server.listen(port, '127.0.0.1', () => {
    console.log(`Meals hub on http://127.0.0.1:${port} (${config.auth.mode} mode). Data: ${dataDir}`);
  });
}
