import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHub, DEFAULT_CONFIG } from '../hub/server.mjs';

const YOU = 'you@dev.local', PARTNER = 'partner@dev.local';

async function startHub(auth = DEFAULT_CONFIG.auth, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meals-hub-test-'));
  const hub = createHub({ dataDir, auth, ...extra });
  await new Promise(resolve => hub.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const call = (route, { as = YOU, headers = {}, ...options } = {}) => fetch(base + route, { ...options, headers: { 'x-hub-dev-user': as, ...headers } });
  const sync = async (as, body) => {
    const res = await call('/api/sync', { as, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(res.status, 200, await res.clone().text());
    return res.json();
  };
  const stop = () => new Promise(resolve => hub.server.close(() => { hub.close(); fs.rmSync(dataDir, { recursive: true, force: true }); resolve(); }));
  return { hub, base, call, sync, stop, dataDir };
}

test('dev mode: names the member, refuses unknown users and anything that came through Cloudflare', async () => {
  const h = await startHub();
  try {
    const session = await (await h.call('/api/session', { as: PARTNER })).json();
    assert.equal(session.member.name, 'Partner');
    assert.equal(session.members.length, 2);
    assert.match(session.household.id, /^[0-9a-f-]{36}$/);
    assert.equal((await h.call('/api/session', { as: 'stranger@example.com' })).status, 403);
    assert.equal((await h.call('/api/session', { headers: { 'cf-ray': 'abc' } })).status, 403, 'tunnel traffic never reaches dev mode');
    assert.equal((await fetch(`${h.base}/api/health`)).status, 200);
    const page = await h.call('/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.equal((await h.call('/../hub/server.mjs')).status, 404);
  } finally { await h.stop(); }
});

test('sync: versions, cursors, and a notice when you replace the other person\'s change', async () => {
  const h = await startHub();
  try {
    const first = await h.sync(YOU, { cursor: 0, records: [{ type: 'pantry', id: 'p_milk', data: { name: 'Milk', state: 'some' }, baseVersion: 0 }], actions: [] });
    assert.deepEqual(first.applied, [{ type: 'pantry', id: 'p_milk', version: 1 }]);
    assert.equal(first.changes.records.length, 0, 'your own writes are not echoed back');

    const partnerPull = await h.sync(PARTNER, { cursor: 0, records: [], actions: [] });
    assert.equal(partnerPull.changes.records[0].data.name, 'Milk');
    assert.equal(partnerPull.changes.records[0].updatedBy, 'You');

    await h.sync(PARTNER, { cursor: partnerPull.cursor, records: [{ type: 'pantry', id: 'p_milk', data: { name: 'Milk', state: 'low' }, baseVersion: 1 }], actions: [] });
    const clash = await h.sync(YOU, { cursor: first.cursor, records: [{ type: 'pantry', id: 'p_milk', data: { name: 'Milk', state: 'out' }, baseVersion: 1 }], actions: [] });
    assert.equal(clash.applied[0].version, 3, 'the later write wins');
    assert.equal(clash.replaced.length, 1);
    assert.equal(clash.replaced[0].by, 'Partner');
    assert.equal(clash.replaced[0].previous.state, 'low');

    const later = await h.sync(PARTNER, { cursor: partnerPull.cursor + 1, records: [], actions: [] });
    assert.deepEqual(later.changes.records.map(record => record.data.state), ['out']);
    const nothing = await h.sync(PARTNER, { cursor: later.cursor, records: [], actions: [] });
    assert.equal(nothing.changes.records.length, 0);
  } finally { await h.stop(); }
});

test('sync: a second live action with the same key is refused with the records it touched', async () => {
  const h = await startHub();
  try {
    const cook = (id, by) => ({ id, key: 'cooked:fp1:Wednesday', data: { id, kind: 'cooked', label: 'Cooked tacos', at: '2026-10-21T18:00:00Z' }, touches: ['p_rice', 'p_left'] });
    const base = await h.sync(YOU, { cursor: 0, records: [{ type: 'pantry', id: 'p_rice', data: { name: 'Rice', qty: { amount: 4, unit: 'cup' } }, baseVersion: 0 }], actions: [] });
    await h.sync(YOU, { cursor: base.cursor, records: [{ type: 'pantry', id: 'p_rice', data: { name: 'Rice', qty: { amount: 2, unit: 'cup' } }, baseVersion: 1 }], actions: [cook('a_you')] });

    const theirs = await h.sync(PARTNER, {
      cursor: base.cursor,
      records: [
        { type: 'pantry', id: 'p_rice', data: { name: 'Rice', qty: { amount: 2, unit: 'cup' } }, baseVersion: 1 },
        { type: 'pantry', id: 'p_left', data: { name: 'Leftovers: tacos', kind: 'leftover' }, baseVersion: 0 },
        { type: 'recipe', id: 'rc_other', data: { name: 'Soup' }, baseVersion: 0 },
      ],
      actions: [cook('a_partner')],
    });
    assert.equal(theirs.rejectedActions.length, 1);
    assert.equal(theirs.rejectedActions[0].by, 'You');
    assert.deepEqual(theirs.skipped.sort(), ['pantry:p_left', 'pantry:p_rice']);
    assert.deepEqual(theirs.applied.map(entry => entry.id), ['rc_other'], 'unrelated changes still go through');
    const rice = theirs.changes.records.find(record => record.id === 'p_rice');
    assert.equal(rice.version, 2, 'the phone gets the hub\'s rice back');
    assert.equal(theirs.changes.records.find(record => record.id === 'p_left').deleted, true, 'the refused leftovers are removed');

    // Undo frees the key for the next cook.
    await h.sync(YOU, { cursor: 0, records: [], actions: [{ ...cook('a_you'), undoneAt: '2026-10-21T19:00:00Z' }] });
    const retry = await h.sync(PARTNER, { cursor: 0, records: [], actions: [cook('a_partner')] });
    assert.equal(retry.rejectedActions.length, 0);
    assert.equal(retry.changes.actions.find(action => action.id === 'a_you').undoneAt, '2026-10-21T19:00:00Z');
  } finally { await h.stop(); }
});

test('sync rejects malformed input and oversized bodies', async () => {
  const h = await startHub();
  try {
    const post = body => h.call('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal((await post('not json')).status, 400);
    assert.equal((await post(JSON.stringify({ cursor: -1 }))).status, 400);
    assert.equal((await post(JSON.stringify({ records: [{ type: 'secrets', id: 'x' }] }))).status, 400);
    assert.equal((await post(JSON.stringify({ records: [{ type: 'pantry', id: '../x' }] }))).status, 400);
    assert.equal((await post('x'.repeat(9 * 1024 * 1024))).status, 413);
  } finally { await h.stop(); }
});

test('photos: store, replace, fetch and delete; only images, only safe ids', async () => {
  const h = await startHub();
  try {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    assert.equal((await h.call('/api/photos/rc_1', { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: jpeg })).status, 200);
    const got = await h.call('/api/photos/rc_1', { as: PARTNER });
    assert.equal(got.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), jpeg);
    assert.equal((await h.call('/api/photos/rc_1', { method: 'PUT', headers: { 'content-type': 'image/png' }, body: Buffer.from([1]) })).status, 200);
    assert.equal((await h.call('/api/photos/rc_1')).headers.get('content-type'), 'image/png', 'a new photo replaces the old one');
    assert.equal((await h.call('/api/photos/rc_1', { method: 'PUT', headers: { 'content-type': 'text/html' }, body: '<b>' })).status, 415);
    assert.equal((await h.call('/api/photos/..%2Fhub', { method: 'GET' })).status, 400);
    assert.equal((await h.call('/api/photos/rc_1', { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: Buffer.alloc(5 * 1024 * 1024) })).status, 413);
    assert.equal((await h.call('/api/photos/rc_1', { method: 'DELETE' })).status, 200);
    assert.equal((await h.call('/api/photos/rc_1')).status, 404);
  } finally { await h.stop(); }
});

test('access mode: only valid Cloudflare Access tokens for household emails get in', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
  const auth = { mode: 'access', teamDomain: 'household.cloudflareaccess.com', audience: 'aud-123', members: [{ email: 'Marcel@Example.com', name: 'Marcel' }] };
  const h = await startHub(auth, { fetchCerts: async () => ({ keys: [jwk] }) });
  const sign = (payload, key = privateKey, kid = 'k1') => {
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
  };
  const good = { aud: ['aud-123'], iss: 'https://household.cloudflareaccess.com', email: 'marcel@example.com', exp: Math.floor(Date.now() / 1000) + 600 };
  const session = token => fetch(`${h.base}/api/session`, { headers: token ? { 'cf-access-jwt-assertion': token } : {} });
  try {
    assert.equal((await session()).status, 401);
    const ok = await session(sign(good));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).member.name, 'Marcel');
    assert.equal((await session(sign({ ...good, aud: ['other'] }))).status, 401);
    assert.equal((await session(sign({ ...good, exp: Math.floor(Date.now() / 1000) - 5 }))).status, 401);
    assert.equal((await session(sign({ ...good, iss: 'https://evil.cloudflareaccess.com' }))).status, 401);
    assert.equal((await session(sign(good, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey))).status, 401);
    assert.equal((await session(sign({ ...good, email: 'stranger@example.com' }))).status, 403);
    assert.equal((await fetch(`${h.base}/api/dev-login?as=you@dev.local`, { headers: { 'cf-access-jwt-assertion': sign(good) }, redirect: 'manual' })).status, 404, 'no dev login in access mode');
  } finally { await h.stop(); }
});
