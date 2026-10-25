// The household API over Node-style req/res, used by the Vercel function and the PC hub alike.
// auth: { identify(req) -> {member:{key,name}} | {status,error,signIn?}, members(), login?(req,res,body), logout?(req,res) }.
import crypto from 'node:crypto';
import { HttpError, MAX_JSON, MAX_PHOTO, PHOTO_ID_RE, PHOTO_TYPES } from './core.js';

export const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };

export function readBody(req, limit) {
  // Vercel may have buffered the body already.
  if (req.readableEnded && req.body !== undefined) {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    return body.length > limit ? Promise.reject(new HttpError(413, 'That upload is too large.')) : Promise.resolve(body);
  }
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

export async function readJSON(req, limit = MAX_JSON * 4) {
  try { return JSON.parse((await readBody(req, limit)).toString('utf8') || '{}'); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'The request was not valid JSON.'); }
}

export function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

function sameSecret(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest(), right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

// Backup routes open only with the separate backup key, which can read everything and change nothing.
async function handleExport(route, req, res, { core, backupToken }) {
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
  if (typeof backupToken !== 'string' || backupToken.length < 24) return send(res, 503, { error: 'Backups are not set up (BACKUP_TOKEN).' });
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!given || !sameSecret(given, backupToken)) return send(res, 401, { error: 'Wrong backup key.' });
  if (route === 'export') return send(res, 200, await core.exportAll());
  const id = route.slice('export/photos/'.length);
  if (!PHOTO_ID_RE.test(id)) return send(res, 400, { error: 'Bad photo id.' });
  const found = await core.getPhoto(id);
  if (!found) return send(res, 404, { error: 'No photo.' });
  res.writeHead(200, { 'Content-Type': found.type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  return res.end(found.data);
}

// The Nexa Fitness link: another site, so it gets CORS for its own address only and a bearer key, not a cookie.
async function handleLink(route, req, res, { core, auth, linkOrigins = [] }) {
  const origin = String(req.headers.origin || '');
  const cors = linkOrigins.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Max-Age': '600', Vary: 'Origin' }
    : {};
  if (req.method === 'OPTIONS') { res.writeHead(cors['Access-Control-Allow-Origin'] ? 204 : 403, { ...cors, ...SECURITY_HEADERS }); return res.end(); }
  if (!auth.createLinkToken) return send(res, 404, { error: 'Not found.' }, cors);
  if (route === 'link' && req.method === 'POST') return auth.createLinkToken(req, res, await readJSON(req, 10_000), cors);
  if (route !== 'link/targets') return send(res, 404, { error: 'Not found.' }, cors);
  const member = auth.verifyLinkToken(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  if (!member) return send(res, 401, { error: 'This link has expired or the passcode changed. Link again from Nexa Fitness.' }, cors);
  if (req.method === 'GET') return send(res, 200, { member: { name: member.name }, targets: await core.getTargets(member.key) }, cors);
  if (req.method === 'PUT') return send(res, 200, { member: { name: member.name }, targets: await core.putTargets(member.key, await readJSON(req, 10_000)) }, cors);
  return send(res, 405, { error: 'Method not allowed.' }, cors);
}

// route: the path after /api/, e.g. "sync" or "photos/rc_1".
export async function handleApi(route, req, res, options) {
  const { core, auth } = options;
  try {
    if (route === 'health' && req.method === 'GET') return send(res, 200, { ok: true });
    if (route === 'export' || route.startsWith('export/photos/')) return await handleExport(route, req, res, options);
    if (route === 'link' || route.startsWith('link/')) return await handleLink(route, req, res, options);
    if (route === 'login' && req.method === 'POST' && auth.login) return await auth.login(req, res, await readJSON(req, 10_000));
    if (route === 'logout' && req.method === 'POST' && auth.logout) return auth.logout(req, res);
    const who = await auth.identify(req);
    if (!who.member) return send(res, who.status, { error: who.error, ...(who.signIn ? { signIn: who.signIn } : {}) });
    const member = who.member;

    if (route === 'session' && req.method === 'GET') {
      return send(res, 200, { member: { key: member.key, name: member.name }, members: auth.members().map(({ key, name }) => ({ key, name })),
        household: { id: await core.household() }, signOut: !!auth.logout });
    }
    if (route === 'sync' && req.method === 'POST') return send(res, 200, await core.sync(member, await readJSON(req)));
    const photo = route.match(/^photos\/([^/]+)$/);
    if (photo) {
      const id = photo[1];
      if (!PHOTO_ID_RE.test(id)) return send(res, 400, { error: 'Bad photo id.' });
      if (req.method === 'PUT') {
        const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!PHOTO_TYPES[type]) return send(res, 415, { error: 'Photos must be JPEG, PNG or WebP.' });
        const body = await readBody(req, MAX_PHOTO);
        if (!body.length) return send(res, 400, { error: 'The photo was empty.' });
        await core.putPhoto(id, type, body);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET') {
        const found = await core.getPhoto(id);
        if (!found) return send(res, 404, { error: 'No photo.' });
        res.writeHead(200, { 'Content-Type': found.type, 'Cache-Control': 'private, no-cache', ...SECURITY_HEADERS });
        return res.end(found.data);
      }
      if (req.method === 'DELETE') { await core.deletePhoto(id); return send(res, 200, { ok: true }); }
      return send(res, 405, { error: 'Method not allowed.' });
    }
    return send(res, 404, { error: 'Not found.' });
  } catch (error) {
    if (error instanceof HttpError) return send(res, error.status, { error: error.message });
    console.error(error);
    return send(res, 500, { error: 'The household server hit an unexpected error.' });
  }
}
