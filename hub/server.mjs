#!/usr/bin/env node
// Meals hub: the household's shared Meal Planner data, kept on this PC.
// It listens on 127.0.0.1 only; phones reach it through Cloudflare Tunnel + Access (mode "access"),
// or, while testing on this PC, directly (mode "dev", which refuses anything that came through Cloudflare).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RECORD_TYPES = ['pantry', 'recipe', 'plan', 'checked', 'history', 'picks', 'feedback', 'prefs', 'planUndo'];
const ID_RE = /^[A-Za-z0-9_:-]{1,60}$/;
const PHOTO_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_JSON = 2 * 1024 * 1024;
const MAX_PHOTO = 4 * 1024 * 1024;
const MAX_ITEMS = 3000;
const PHOTO_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
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

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS records (
      type TEXT NOT NULL, id TEXT NOT NULL, data TEXT, deleted INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, seq INTEGER NOT NULL,
      PRIMARY KEY (type, id));
    CREATE INDEX IF NOT EXISTS records_seq ON records (seq);
    CREATE TABLE IF NOT EXISTS actions (
      id TEXT PRIMARY KEY, key TEXT NOT NULL, data TEXT NOT NULL, undone_at TEXT,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, seq INTEGER NOT NULL);
    -- One live action per key: two phones can't both log "cooked Wednesday".
    CREATE UNIQUE INDEX IF NOT EXISTS actions_active_key ON actions (key) WHERE undone_at IS NULL;
    CREATE INDEX IF NOT EXISTS actions_seq ON actions (seq);`);
  if (!db.prepare("SELECT value FROM meta WHERE key = 'household'").get()) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('household', ?), ('seq', '0')").run(crypto.randomUUID());
  }
  return db;
}

function readCookie(req, name) {
  const match = String(req.headers.cookie || '').split(/;\s*/).find(part => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}

export function createAuth(config, { now = () => Date.now(), fetchCerts } = {}) {
  const members = new Map((config.members || []).map(member => {
    const email = String(member.email).trim().toLowerCase();
    return [email, { email, name: String(member.name || email) }];
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
    nameOf: email => members.get(email)?.name || email,
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

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit * 4) { req.resume(); reject(new HttpError(413, 'That upload is too large.')); return; }
    // Past the limit, keep draining so the phone gets a clear "too large" answer instead of a dropped connection.
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => size > limit ? reject(new HttpError(413, 'That upload is too large.')) : resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createHub({ dataDir, appFile = path.join(HERE, '..', 'index.html'), auth: authConfig, now = () => new Date(), fetchCerts }) {
  const photoDir = path.join(dataDir, 'photos');
  fs.mkdirSync(photoDir, { recursive: true });
  const db = openDatabase(path.join(dataDir, 'meals.sqlite'));
  const auth = createAuth(authConfig, { now: () => now().getTime(), fetchCerts });
  const sql = {
    household: db.prepare("SELECT value FROM meta WHERE key = 'household'"),
    seq: db.prepare("SELECT value FROM meta WHERE key = 'seq'"),
    setSeq: db.prepare("UPDATE meta SET value = ? WHERE key = 'seq'"),
    record: db.prepare('SELECT * FROM records WHERE type = ? AND id = ?'),
    insertRecord: db.prepare('INSERT INTO records (type, id, data, deleted, version, updated_at, updated_by, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    updateRecord: db.prepare('UPDATE records SET data = ?, deleted = ?, version = ?, updated_at = ?, updated_by = ?, seq = ? WHERE type = ? AND id = ?'),
    recordsSince: db.prepare('SELECT * FROM records WHERE seq > ? ORDER BY seq'),
    action: db.prepare('SELECT * FROM actions WHERE id = ?'),
    activeAction: db.prepare('SELECT * FROM actions WHERE key = ? AND undone_at IS NULL'),
    insertAction: db.prepare('INSERT INTO actions (id, key, data, undone_at, created_by, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    undoAction: db.prepare('UPDATE actions SET undone_at = ?, seq = ? WHERE id = ?'),
    actionsSince: db.prepare('SELECT * FROM actions WHERE seq > ? ORDER BY seq'),
  };

  const recordOut = row => ({ type: row.type, id: row.id, data: row.deleted ? null : JSON.parse(row.data), deleted: !!row.deleted,
    version: row.version, updatedAt: row.updated_at, updatedBy: auth.nameOf(row.updated_by) });
  const actionOut = row => ({ ...JSON.parse(row.data), id: row.id, key: row.key, undoneAt: row.undone_at, createdBy: auth.nameOf(row.created_by) });

  function validateSync(input) {
    if (!input || typeof input !== 'object') throw new HttpError(400, 'Expected a JSON object.');
    const cursor = Number(input.cursor ?? 0);
    if (!Number.isInteger(cursor) || cursor < 0) throw new HttpError(400, 'cursor must be a whole number.');
    const records = input.records ?? [], actions = input.actions ?? [];
    if (!Array.isArray(records) || !Array.isArray(actions) || records.length > MAX_ITEMS || actions.length > MAX_ITEMS) throw new HttpError(400, 'records and actions must be lists.');
    for (const record of records) {
      if (!RECORD_TYPES.includes(record?.type) || typeof record.id !== 'string' || !ID_RE.test(record.id)) throw new HttpError(400, 'A record has an unknown type or a bad id.');
    }
    for (const action of actions) {
      if (typeof action?.id !== 'string' || !ID_RE.test(action.id) || typeof action.key !== 'string' || !action.key || action.key.length > 2000 || !action.data || typeof action.data !== 'object') {
        throw new HttpError(400, 'An action is malformed.');
      }
    }
    return { cursor, records, actions };
  }

  // Push then pull in one transaction. Records: the later write wins, and the writer hears whose change it replaced.
  // Actions: a second live action with the same key is refused, along with the pantry records it touched.
  function sync(member, input) {
    const { cursor, records, actions } = validateSync(input);
    const stamp = now().toISOString();
    const applied = [], replaced = [], rejectedActions = [], skipped = [];
    const written = new Set(), writtenActions = new Set(), skipKeys = new Set();
    db.exec('BEGIN IMMEDIATE');
    let seq;
    try {
      seq = Number(sql.seq.get().value);
      for (const action of actions) {
        const existing = sql.action.get(action.id);
        const undoneAt = typeof action.undoneAt === 'string' ? action.undoneAt : null;
        if (existing) {
          if (undoneAt && !existing.undone_at) { sql.undoAction.run(undoneAt, ++seq, action.id); writtenActions.add(action.id); }
          continue;
        }
        if (!undoneAt) {
          const duplicate = sql.activeAction.get(action.key);
          if (duplicate) {
            rejectedActions.push({ id: action.id, key: action.key, existingId: duplicate.id, by: auth.nameOf(duplicate.created_by), at: duplicate.created_at, label: String(action.data.label || '') });
            (Array.isArray(action.touches) ? action.touches : []).forEach(id => { if (typeof id === 'string' && ID_RE.test(id)) skipKeys.add(`pantry\u0000${id}`); });
            continue;
          }
        }
        sql.insertAction.run(action.id, action.key, JSON.stringify(action.data), undoneAt, member.email, stamp, ++seq);
        writtenActions.add(action.id);
      }
      for (const record of records) {
        const key = `${record.type}\u0000${record.id}`;
        if (skipKeys.has(key)) { skipped.push(key); continue; }
        const current = sql.record.get(record.type, record.id);
        const deleted = record.deleted === true;
        const data = deleted ? null : JSON.stringify(record.data ?? null);
        if (data && data.length > MAX_JSON) throw new HttpError(413, 'A record is too large.');
        if (!current) {
          sql.insertRecord.run(record.type, record.id, data, deleted ? 1 : 0, 1, stamp, member.email, ++seq);
          applied.push({ type: record.type, id: record.id, version: 1 });
        } else {
          if (current.version !== Number(record.baseVersion) && current.updated_by !== member.email) {
            replaced.push({ type: record.type, id: record.id, by: auth.nameOf(current.updated_by), at: current.updated_at,
              previous: current.deleted ? null : JSON.parse(current.data), previousDeleted: !!current.deleted });
          }
          sql.updateRecord.run(data, deleted ? 1 : 0, current.version + 1, stamp, member.email, ++seq, record.type, record.id);
          applied.push({ type: record.type, id: record.id, version: current.version + 1 });
        }
        written.add(key);
      }
      sql.setSeq.run(String(seq));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const changedRecords = sql.recordsSince.all(cursor).filter(row => !written.has(`${row.type}\u0000${row.id}`)).map(recordOut);
    // Records held back with a refused action come back as the hub has them, so the phone drops its version.
    skipped.forEach(key => {
      if (changedRecords.some(record => `${record.type}\u0000${record.id}` === key)) return;
      const [type, id] = key.split('\u0000');
      const row = sql.record.get(type, id);
      changedRecords.push(row ? recordOut(row) : { type, id, data: null, deleted: true, version: 0, updatedAt: stamp, updatedBy: '' });
    });
    const changedActions = sql.actionsSince.all(cursor).filter(row => !writtenActions.has(row.id)).map(actionOut);
    return { cursor: seq, applied, replaced, rejectedActions, skipped: skipped.map(key => key.replace('\u0000', ':')), changes: { records: changedRecords, actions: changedActions } };
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
    res.end(JSON.stringify(body));
  }
  function photoFile(id) {
    for (const ext of Object.values(PHOTO_TYPES)) {
      const file = path.join(photoDir, `${id}${ext}`);
      if (fs.existsSync(file)) return file;
    }
    return null;
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://hub.local');
      const route = url.pathname;
      if (route === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true });
      const who = await auth.identify(req);
      if (!who.member) return send(res, who.status, { error: who.error });
      const member = who.member;

      if ((route === '/' || route === '/index.html') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Security-Policy': APP_CSP, ...SECURITY_HEADERS });
        return res.end(fs.readFileSync(appFile));
      }
      if (route === '/api/dev-login' && req.method === 'GET' && authConfig.mode !== 'access') {
        const email = String(url.searchParams.get('as') || '').toLowerCase();
        if (!auth.members().some(entry => entry.email === email)) return send(res, 400, { error: 'Unknown dev user.' });
        res.writeHead(302, { Location: '/', 'Set-Cookie': `hub_dev_user=${encodeURIComponent(email)}; Path=/; HttpOnly; SameSite=Strict`, ...SECURITY_HEADERS });
        return res.end();
      }
      if (route === '/api/session' && req.method === 'GET') {
        return send(res, 200, { member, members: auth.members().map(({ email, name }) => ({ email, name })), household: { id: sql.household.get().value }, serverTime: now().toISOString() });
      }
      if (route === '/api/sync' && req.method === 'POST') {
        let input;
        try { input = JSON.parse((await readBody(req, MAX_JSON * 4)).toString('utf8') || '{}'); }
        catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'The request was not valid JSON.'); }
        return send(res, 200, sync(member, input));
      }
      const photo = route.match(/^\/api\/photos\/([^/]+)$/);
      if (photo) {
        const id = photo[1];
        if (!PHOTO_ID_RE.test(id)) return send(res, 400, { error: 'Bad photo id.' });
        if (req.method === 'PUT') {
          const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
          const ext = PHOTO_TYPES[type];
          if (!ext) return send(res, 415, { error: 'Photos must be JPEG, PNG or WebP.' });
          const body = await readBody(req, MAX_PHOTO);
          if (!body.length) return send(res, 400, { error: 'The photo was empty.' });
          const target = path.join(photoDir, `${id}${ext}`), temp = `${target}.${process.pid}.tmp`;
          fs.writeFileSync(temp, body);
          Object.values(PHOTO_TYPES).forEach(other => { const old = path.join(photoDir, `${id}${other}`); if (old !== target && fs.existsSync(old)) fs.rmSync(old); });
          fs.renameSync(temp, target);
          return send(res, 200, { ok: true });
        }
        if (req.method === 'GET') {
          const file = photoFile(id);
          if (!file) return send(res, 404, { error: 'No photo.' });
          const type = Object.entries(PHOTO_TYPES).find(([, ext]) => file.endsWith(ext))[0];
          res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, no-cache', ...SECURITY_HEADERS });
          return res.end(fs.readFileSync(file));
        }
        if (req.method === 'DELETE') {
          Object.values(PHOTO_TYPES).forEach(ext => { const file = path.join(photoDir, `${id}${ext}`); if (fs.existsSync(file)) fs.rmSync(file); });
          return send(res, 200, { ok: true });
        }
        return send(res, 405, { error: 'Method not allowed.' });
      }
      if (route.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      return res.end('Not found');
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      console.error(error);
      return send(res, 500, { error: 'The hub hit an unexpected error.' });
    }
  }

  return { handle, db, server: http.createServer(handle), close: () => db.close() };
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
