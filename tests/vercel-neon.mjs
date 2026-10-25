// The Vercel + Neon deployment, tested on PGlite (Postgres compiled to WebAssembly) so the same SQL runs here.
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { createCore } from '../api/_lib/core.js';
import { handleApi } from '../api/_lib/http.js';
import { createPasscodeAuth, memberList } from '../api/_lib/passcode-auth.js';
import handler from '../api/hub.js';
import { createApp } from './helpers/load-app.mjs';

const PASSCODE = 'test-passcode-for-household';
const plain = value => JSON.parse(JSON.stringify(value));

function pgliteDatabase(pg) {
  return {
    blobType: 'BYTEA',
    async query(sql, params) { return (await pg.query(sql, params)).rows; },
    transaction(fn) { return pg.transaction(tx => fn({ query: async (sql, params) => (await tx.query(sql, params)).rows })); },
  };
}

async function startServer({ passcode = PASSCODE, members = 'Marcel, Partner', now } = {}) {
  const pg = new PGlite();
  let auth;
  const core = createCore({ db: pgliteDatabase(pg), nameOf: key => auth.nameOf(key), ...(now ? { now } : {}) });
  auth = createPasscodeAuth({ passcode, members, core, secure: false });
  const server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://local').pathname.replace(/^\/api\/?/, '');
    handleApi(route, req, res, { core, auth });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, core, stop: () => new Promise(resolve => server.close(async () => { await pg.close(); resolve(); })) };
}

// A phone keeps its own cookie, like a browser does.
function cookieFetch(base) {
  let cookie = '';
  return async (route, options = {}) => {
    const res = await fetch(base + route, { ...options, headers: { ...(options.headers || {}), ...(cookie ? { cookie } : {}) } });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    return res;
  };
}

async function phone(base, storage = {}) {
  const ctx = createApp(storage, { fetch: cookieFetch(base) });
  ctx.app.init();
  ctx.connected = await ctx.app.__state().hubReady;
  ctx.item = name => plain(ctx.app.__state().pantryItems.find(entry => entry.name === name && !entry.archived) ?? null);
  return ctx;
}

test('member names come from a comma list', () => {
  assert.deepEqual(memberList(' Marcel , Ana María ,,'), [{ key: 'marcel', name: 'Marcel' }, { key: 'ana-mar-a', name: 'Ana María' }]);
});

test('passcode sign-in: wrong code refused and rate limited, right code picks a name and signs in for 90 days', async () => {
  const s = await startServer();
  try {
    const post = (route, body, headers = {}) => fetch(`${s.base}/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await fetch(`${s.base}/api/session`)).status, 401);
    assert.equal((await (await fetch(`${s.base}/api/session`)).json()).signIn, 'passcode');
    assert.equal((await post('login', { passcode: 'nope' })).status, 401);
    const step1 = await (await post('login', { passcode: PASSCODE })).json();
    assert.deepEqual(step1.members.map(member => member.name), ['Marcel', 'Partner']);
    const step2 = await post('login', { passcode: PASSCODE, member: 'partner' });
    const cookie = step2.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Max-Age=7776000/);
    const session = await (await fetch(`${s.base}/api/session`, { headers: { cookie: cookie.split(';')[0] } })).json();
    assert.equal(session.member.name, 'Partner');
    assert.equal((await fetch(`${s.base}/api/session`, { headers: { cookie: `${cookie.split(';')[0]}x` } })).status, 401, 'a tampered cookie is refused');

    const attacker = { 'x-real-ip': '203.0.113.9' };
    for (let i = 0; i < 10; i++) assert.equal((await post('login', { passcode: `guess-${i}` }, attacker)).status, 401);
    assert.equal((await post('login', { passcode: PASSCODE }, attacker)).status, 429, 'locked out after 10 wrong tries');
    assert.equal((await post('login', { passcode: PASSCODE }, { 'x-real-ip': '198.51.100.1' })).status, 200, 'other phones are unaffected');
  } finally { await s.stop(); }
});

test('changing the passcode signs every phone out', async () => {
  const s = await startServer();
  try {
    const res = await fetch(`${s.base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: PASSCODE, member: 'marcel' }) });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const rotated = createPasscodeAuth({ passcode: 'a-brand-new-passcode', members: 'Marcel, Partner', core: s.core });
    assert.equal((await rotated.identify({ headers: { cookie } })).status, 401);
  } finally { await s.stop(); }
});

test('without a passcode configured, nothing is reachable', async () => {
  const s = await startServer({ passcode: '' });
  try {
    assert.equal((await fetch(`${s.base}/api/session`)).status, 503);
    assert.equal((await fetch(`${s.base}/api/login`, { method: 'POST', body: '{"passcode":""}' })).status, 503);
  } finally { await s.stop(); }
});

test('the Vercel function says so when the database is not connected', async () => {
  const saved = process.env.DATABASE_URL; delete process.env.DATABASE_URL;
  let status, body;
  await handler({ url: '/api/hub?route=session', method: 'GET', headers: {} }, { writeHead(code) { status = code; }, end(text) { body = text; } });
  if (saved) process.env.DATABASE_URL = saved;
  assert.equal(status, 503);
  assert.match(JSON.parse(body).error, /not connected/);
});

test('two phones sign in with the passcode and sync through Postgres, including a refused duplicate cook', async () => {
  const s = await startServer();
  try {
    const you = await phone(s.base);
    assert.equal(you.connected, 'signin');
    assert.equal(you.app.__state().hub.state, 'signin');
    assert.match(you.el('hubSheetBody').innerHTML, /hubPasscode/);
    assert.equal(await you.app.hubSignIn('wrong-passcode'), 'error');
    assert.match(you.el('hubSheetBody').innerHTML, /isn(&#39;|')t right/);
    const names = await you.app.hubSignIn(PASSCODE);
    assert.equal(names, 'pick');
    assert.match(you.el('hubSheetBody').innerHTML, /Marcel/);
    assert.equal(await you.app.hubSignIn(PASSCODE, 'marcel'), 'synced');
    assert.equal(you.app.__state().hub.member.name, 'Marcel');

    you.app.addPantryItem({ name: 'Rice', location: 'pantry', state: 'plenty', amount: '4', unit: 'cup' });
    you.el('proposalInput').value = JSON.stringify({
      format: 'nexa-meal-plan-proposal/v1', proposalId: 'neon-week', window: { start: '2026-10-28', end: '2026-11-03' },
      weeklyMealPlan: [{ day: 'Wednesday', dinner: { name: 'Rice bowls', ingredients: ['2 cups rice'] } }], groceryList: {}, estimatedTotal: 0,
    });
    you.app.checkProposal(); you.app.acceptProposal();
    await you.app.hubSync();

    const partner = await phone(s.base);
    await partner.app.hubSignIn(PASSCODE, 'partner');
    assert.equal(partner.item('Rice').state, 'plenty');
    assert.equal(partner.app.__state().mealPlan.weeklyMealPlan[0].dinner.name, 'Rice bowls');

    you.app.openCookSheet('Wednesday'); you.app.applyCook();
    partner.app.openCookSheet('Wednesday'); partner.app.applyCook();
    await you.app.hubSync();
    await partner.app.hubSync();
    assert.deepEqual(partner.item('Rice').qty, { amount: 2, unit: 'cup' });
    assert.match(partner.el('toast').innerHTML, /Marcel already logged/);

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 1, 2]);
    const fetchAsYou = cookieFetch(s.base);
    await fetchAsYou('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: PASSCODE, member: 'marcel' }) });
    assert.equal((await fetchAsYou('/api/photos/rc_1', { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: jpeg })).status, 200);
    assert.deepEqual(Buffer.from(await (await fetchAsYou('/api/photos/rc_1')).arrayBuffer()), jpeg, 'photos round-trip through bytea');

    assert.equal(await you.app.hubSignOut(), 'signin');
    assert.equal(await you.app.hubSync(), 'signin', 'signed out phones stop syncing');
    assert.deepEqual(you.item('Rice').qty, { amount: 2, unit: 'cup' }, 'and keep their data on the phone');
  } finally { await s.stop(); }
});
