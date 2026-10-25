// Phase 5: weekly backup export, the Nexa Fitness targets link, and "who ate it" totals (on PGlite).
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { createCore } from '../api/_lib/core.js';
import { handleApi } from '../api/_lib/http.js';
import { createPasscodeAuth } from '../api/_lib/passcode-auth.js';
import { runBackup, verifyBackup } from '../tools/backup-meals.mjs';
import { createApp } from './helpers/load-app.mjs';

const PASSCODE = 'test-passcode-for-household';
const BACKUP_TOKEN = 'backup-token-that-is-long-enough-123';
const FITNESS = 'https://nexa-fitness.vercel.app';
const plain = value => JSON.parse(JSON.stringify(value));

async function startServer({ backupToken = BACKUP_TOKEN, passcode = PASSCODE } = {}) {
  const pg = new PGlite();
  const db = { blobType: 'BYTEA', async query(s, p) { return (await pg.query(s, p)).rows; }, transaction(fn) { return pg.transaction(tx => fn({ query: async (s, p) => (await tx.query(s, p)).rows })); } };
  let auth;
  const core = createCore({ db, nameOf: key => auth.nameOf(key) });
  auth = createPasscodeAuth({ passcode, members: 'Marcel, Partner', core, secure: false });
  const options = { core, auth, backupToken, linkOrigins: [FITNESS] };
  const server = http.createServer((req, res) => handleApi(new URL(req.url, 'http://x').pathname.replace(/^\/api\/?/, ''), req, res, options));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, core, options, stop: () => new Promise(resolve => server.close(async () => { await pg.close(); resolve(); })) };
}

function cookieFetch(base) {
  let cookie = '';
  return async (route, options = {}) => {
    const res = await fetch(base + route, { ...options, headers: { ...(options.headers || {}), ...(cookie ? { cookie } : {}) } });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return res;
  };
}
async function phone(base, member) {
  const ctx = createApp({}, { fetch: cookieFetch(base) });
  ctx.app.init();
  await ctx.app.__state().hubReady;
  assert.equal(await ctx.app.hubSignIn(PASSCODE, member), 'synced');
  return ctx;
}
const json = (method, body, headers = {}) => ({ method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('backup export opens only with the backup key and changes nothing', async () => {
  const s = await startServer();
  try {
    assert.equal((await fetch(`${s.base}/api/export`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/export`, { headers: { authorization: 'Bearer wrong-key-wrong-key-wrong-key' } })).status, 401);
    assert.equal((await fetch(`${s.base}/api/export`, { method: 'POST', headers: { authorization: `Bearer ${BACKUP_TOKEN}` } })).status, 405);
    const dump = await (await fetch(`${s.base}/api/export`, { headers: { authorization: `Bearer ${BACKUP_TOKEN}` } })).json();
    assert.equal(dump.format, 'nexa-meal-backup/v1');
    const session = cookieFetch(s.base);
    await session('/api/login', json('POST', { passcode: PASSCODE, member: 'marcel' }));
    assert.equal((await session('/api/export')).status, 401, 'a household sign-in is not a backup key');
  } finally { await s.stop(); }
  const unset = await startServer({ backupToken: '' });
  try { assert.equal((await fetch(`${unset.base}/api/export`, { headers: { authorization: 'Bearer anything-anything-anything' } })).status, 503); }
  finally { await unset.stop(); }
});

test('weekly backup downloads, proves it restores, and keeps the newest 12', async () => {
  const s = await startServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meal-backups-'));
  try {
    const you = await phone(s.base, 'marcel');
    you.app.addPantryItem({ name: 'Rice', location: 'pantry', state: 'plenty' });
    you.app.addRecipe({ name: 'Tacos', ingredients: '8 tortillas' });
    await you.app.hubSync();
    const session = cookieFetch(s.base);
    await session('/api/login', json('POST', { passcode: PASSCODE, member: 'marcel' }));
    await session('/api/photos/rc_1', { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: Buffer.from([0xff, 0xd8, 9]) });

    const first = await runBackup({ dir, url: s.base, token: BACKUP_TOKEN, now: new Date(2026, 9, 25, 4) });
    assert.equal(first.photos, 1);
    assert.ok(first.records >= 2);
    assert.ok(fs.existsSync(path.join(first.folder, 'photos', 'rc_1.jpg')));
    assert.deepEqual(plain(await verifyBackup(first.folder)), { records: first.records, actions: first.actions, photos: 1 });

    fs.rmSync(path.join(first.folder, 'photos', 'rc_1.jpg'));
    await assert.rejects(verifyBackup(first.folder), /ENOENT|missing photo/i, 'a damaged backup is caught');

    for (let week = 1; week <= 13; week++) await runBackup({ dir, url: s.base, token: BACKUP_TOKEN, now: new Date(2026, 9, 25 + week * 7, 4) });
    const kept = fs.readdirSync(dir).filter(name => /^\d{4}-/.test(name)).sort();
    assert.equal(kept.length, 12);
    assert.ok(!kept.some(name => name.endsWith('.partial')));
    await assert.rejects(runBackup({ dir, url: s.base, token: 'wrong-token-wrong-token-wrong' }), /Export failed: 401/);

    // Two runs in the same second (e.g. the weekly task right after a manual run) both land.
    const same = new Date(2027, 5, 1, 4);
    const a = await runBackup({ dir, url: s.base, token: BACKUP_TOKEN, now: same });
    const b = await runBackup({ dir, url: s.base, token: BACKUP_TOKEN, now: same });
    assert.notEqual(a.folder, b.folder);
    assert.ok(fs.existsSync(b.folder));
    assert.ok(!fs.readdirSync(dir).some(name => name.endsWith('.partial')), 'no half-written folders are left behind');
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('phones can never write targets through sync', async () => {
  const s = await startServer();
  try {
    const session = cookieFetch(s.base);
    await session('/api/login', json('POST', { passcode: PASSCODE, member: 'marcel' }));
    const res = await session('/api/sync', json('POST', { cursor: 0, records: [{ type: 'targets', id: 'marcel', data: { calories: 9999 }, baseVersion: 0 }] }));
    assert.equal(res.status, 403);
  } finally { await s.stop(); }
});

test('Fitness link: CORS for the Fitness site only, a key that can only set one person\'s targets', async () => {
  const s = await startServer();
  try {
    const pre = origin => fetch(`${s.base}/api/link/targets`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'PUT' } });
    const ok = await pre(FITNESS);
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), FITNESS);
    assert.equal((await pre('https://evil.example')).status, 403);

    const from = { origin: FITNESS };
    assert.equal((await fetch(`${s.base}/api/link`, json('POST', { passcode: 'nope' }, from))).status, 401);
    const names = await (await fetch(`${s.base}/api/link`, json('POST', { passcode: PASSCODE }, from))).json();
    assert.deepEqual(names.members.map(member => member.key), ['marcel', 'partner']);
    const linked = await fetch(`${s.base}/api/link`, json('POST', { passcode: PASSCODE, member: 'partner' }, from));
    assert.equal(linked.headers.get('access-control-allow-origin'), FITNESS);
    const { token } = await linked.json();
    assert.equal(linked.headers.get('set-cookie'), null, 'the link never sets a cookie');

    const put = body => fetch(`${s.base}/api/link/targets`, json('PUT', body, { ...from, authorization: `Bearer ${token}` }));
    assert.equal((await put({ calories: 'lots' })).status, 400);
    assert.equal((await put({})).status, 400);
    const saved = await (await put({ calories: 2100.4, protein: 140, carbs: null, fat: 70 })).json();
    assert.deepEqual(plain(saved.targets), { ...saved.targets, calories: 2100, protein: 140, carbs: null, fat: 70, member: 'partner', source: 'fitness' });
    assert.equal((await (await fetch(`${s.base}/api/link/targets`, { headers: { authorization: `Bearer ${token}` } })).json()).targets.calories, 2100);

    assert.equal((await fetch(`${s.base}/api/session`, { headers: { cookie: `meals_session=${token}` } })).status, 401, 'a link key is not a household sign-in');
    assert.equal((await fetch(`${s.base}/api/sync`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })).status, 401);
    const login = await fetch(`${s.base}/api/login`, json('POST', { passcode: PASSCODE, member: 'marcel' }));
    const cookieValue = login.headers.get('set-cookie').split(';')[0].split('=')[1];
    assert.equal((await fetch(`${s.base}/api/link/targets`, json('PUT', { calories: 1 }, { authorization: `Bearer ${cookieValue}` }))).status, 401, 'a sign-in cookie is not a link key');

    const rotated = createPasscodeAuth({ passcode: 'a-brand-new-passcode', members: 'Marcel, Partner', core: s.core });
    assert.equal(rotated.verifyLinkToken(token), null, 'changing the passcode unlinks Fitness too');
  } finally { await s.stop(); }
});

test('who ate it: portions per person, nutrition carried to leftovers, Today card against Fitness targets', async () => {
  const s = await startServer();
  try {
    const { token } = await (await fetch(`${s.base}/api/link`, json('POST', { passcode: PASSCODE, member: 'marcel' }))).json();
    await fetch(`${s.base}/api/link/targets`, json('PUT', { calories: 2000, protein: 150 }, { authorization: `Bearer ${token}` }));

    const you = await phone(s.base, 'marcel');
    you.app.renderHome();
    assert.match(you.el('homeContent').innerHTML, /0 \/ 2000 kcal/, 'targets show before any week is planned');
    const today = new Date();
    const wed = new Date(today); wed.setDate(today.getDate() - ((today.getDay() - 3 + 7) % 7));
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const end = new Date(wed); end.setDate(wed.getDate() + 6);
    you.el('proposalInput').value = JSON.stringify({
      format: 'nexa-meal-plan-proposal/v1', proposalId: 'p5', window: { start: iso(wed), end: iso(end) },
      weeklyMealPlan: [
        { day: 'Wednesday', alsoEatenOn: 'Thursday', dinner: { name: 'Chicken bowls', ingredients: ['1 cup rice'], nutritionPerServing: { calories: 600, protein: 45, carbs: 60, fat: 15 } } },
        { day: 'Thursday', isLeftoverNight: true, dinner: { name: 'Chicken bowls' } },
      ],
      groceryList: {}, estimatedTotal: 0,
    });
    you.app.checkProposal(); you.app.acceptProposal();

    assert.equal(you.app.openCookSheet('Wednesday'), 'ready');
    assert.deepEqual(plain(you.app.__state().cookDraft.eaten), { marcel: 1, partner: 1 }, 'everyone starts at one portion');
    assert.match(you.el('cookSheetBody').innerHTML, /Who ate it[\s\S]*600 kcal per portion \(estimate\)/);
    you.app.setEaten('partner', 0.5);
    you.app.setLeftoverField('portions', '3');
    assert.equal(you.app.applyCook(), 'applied');
    const cook = plain(you.app.__state().actions.find(action => action.kind === 'cooked'));
    assert.deepEqual(cook.eaten, { marcel: 1, partner: 1.5 });
    assert.equal(cook.perServing.calories, 600);

    assert.equal(you.app.openAteSheet('Thursday'), 'ready');
    you.app.setEaten('partner', -1);
    assert.equal(you.app.__state().ateDraft.portions, 1, 'leftover portions follow who ate');
    assert.equal(you.app.applyAte(), 'applied');
    const ate = plain(you.app.__state().actions.find(action => action.kind === 'ate'));
    assert.equal(ate.perServing.calories, 600, 'leftovers remember the meal\'s nutrition');

    await you.app.hubSync();
    const totals = plain(you.app.dayTotals('marcel', iso(today)));
    assert.deepEqual(totals, { calories: 1200, protein: 90, carbs: 120, fat: 30, meals: 2, unknown: 0 });
    you.app.renderHome(today);
    const home = you.el('homeContent').innerHTML;
    assert.match(home, /Today · estimates/);
    assert.match(home, /1200 \/ 2000 kcal/);
    assert.match(home, /Partner[\s\S]*Set your targets in Nexa Fitness/);

    you.app.undoAction(cook.id);
    assert.equal(you.app.dayTotals('marcel', iso(today)).calories, 600, 'undoing a meal takes it off the day');
  } finally { await s.stop(); }
});

test('without the household server there is no "who ate it" step', () => {
  const ctx = createApp({}, { fetch: async () => new Response('nope', { status: 404 }) });
  ctx.app.init();
  ctx.app.addRecipe({ name: 'Soup', ingredients: '1 cup lentils', steps: 'Simmer' });
  ctx.app.openRecipeCookSheet(ctx.app.__state().recipes[0].id);
  assert.doesNotMatch(ctx.el('cookSheetBody').innerHTML, /Who ate it/);
});
