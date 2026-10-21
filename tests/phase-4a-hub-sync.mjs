import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './helpers/load-app.mjs';
import { createHub, DEFAULT_CONFIG } from '../hub/server.mjs';

const YOU = 'you@dev.local', PARTNER = 'partner@dev.local';
const plain = value => JSON.parse(JSON.stringify(value));
const notFound = async () => new Response('<html>Not found</html>', { status: 404, headers: { 'content-type': 'text/html' } });

async function startHub() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meals-hub-sync-'));
  const hub = createHub({ dataDir, auth: DEFAULT_CONFIG.auth });
  await new Promise(resolve => hub.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  return { base, stop: () => new Promise(resolve => hub.server.close(() => { hub.close(); fs.rmSync(dataDir, { recursive: true, force: true }); resolve(); })) };
}

// A phone is an app instance with its own storage, talking to the hub as one household member.
async function phone(base, email, storage = {}) {
  const ctx = createApp(storage, { fetch: (route, options = {}) => fetch(base + route, { ...options, headers: { ...(options.headers || {}), 'x-hub-dev-user': email } }) });
  ctx.app.init();
  ctx.connected = await ctx.app.__state().hubReady;
  ctx.item = name => plain(ctx.app.__state().pantryItems.find(entry => entry.name === name && !entry.archived) ?? null);
  ctx.recipe = name => plain(ctx.app.__state().recipes.filter(entry => entry.name === name && !entry.deleted));
  ctx.toast = () => ctx.el('toast').innerHTML;
  return ctx;
}

// Builds a phone's data with no hub around, so it starts as "this phone only".
function offlinePhone(storage, build) {
  const ctx = createApp(storage, { fetch: notFound });
  ctx.app.init();
  build(ctx.app, ctx);
  return storage;
}

function acceptWeek(app, el) {
  el('proposalInput').value = JSON.stringify({
    format: 'nexa-meal-plan-proposal/v1', proposalId: 'hub-week', window: { start: '2026-10-21', end: '2026-10-27' },
    weeklyMealPlan: [{ day: 'Wednesday', alsoEatenOn: 'Thursday', dinner: { name: 'Rice bowls', ingredients: ['2 cups rice'], steps: ['Cook rice'] } },
      { day: 'Thursday', isLeftoverNight: true, dinner: { name: 'Rice bowls' } }],
    groceryList: { produce: [{ name: 'Cilantro', quantity: '1 bunch', estimatedPrice: 1 }] }, estimatedTotal: 1,
  });
  app.checkProposal();
  assert.equal(app.acceptProposal(), 'accepted');
}

test('without a hub the app stays phone-only and can only ever call its own /api/ paths', async () => {
  const ctx = createApp({}, { fetch: notFound });
  ctx.app.init();
  assert.equal(await ctx.app.__state().hubReady, 'off');
  assert.equal(ctx.app.__state().hub.state, 'off');
  for (const target of ['https://example.com/api/sync', '//example.com/api/sync', '/api/../secrets', 'api/sync']) {
    await assert.rejects(ctx.app.hubRequest(target), /hub/i, target);
  }
  const offline = createApp({});
  offline.app.init();
  assert.equal(await offline.app.__state().hubReady, 'off', 'no fetch at all (opened as a file) is also phone-only');
});

test('first phone uploads what it has; the second phone downloads it', async () => {
  const h = await startHub();
  try {
    const storage = offlinePhone({}, (app, { el }) => {
      app.addPantryItem({ name: 'Milk', location: 'fridge', state: 'some' });
      app.addPantryItem({ name: 'Rice', location: 'pantry', state: 'plenty', amount: '4', unit: 'cup' });
      app.addRecipe({ name: 'Tacos', ingredients: '8 tortillas', steps: 'Warm' });
      app.setBudget(110);
      acceptWeek(app, el);
    });
    const you = await phone(h.base, YOU, storage);
    assert.equal(you.connected, 'synced');
    assert.match(you.toast(), /now the household/);

    const partner = await phone(h.base, PARTNER);
    assert.equal(partner.connected, 'synced');
    assert.equal(partner.app.__state().hub.member.name, 'Partner');
    assert.equal(partner.item('Milk').state, 'some');
    assert.equal(partner.recipe('Tacos').length, 1);
    assert.equal(partner.app.__state().mealPlan.weeklyMealPlan[0].dinner.name, 'Rice bowls');
    assert.equal(partner.app.__state().weeklyBudget, 110);
    assert.equal(partner.el('budgetDisplay').textContent, 110, 'settings screens refresh too');
  } finally { await h.stop(); }
});

test('changes flow both ways and say who made them', async () => {
  const h = await startHub();
  try {
    const you = await phone(h.base, YOU);
    you.app.addPantryItem({ name: 'Milk', location: 'fridge', state: 'some' });
    await you.app.hubSync();
    const partner = await phone(h.base, PARTNER);
    partner.app.setPantryState(partner.item('Milk').id, 'out');
    partner.app.addRecipe({ name: 'Soup', ingredients: '1 cup lentils' });
    await partner.app.hubSync();
    await you.app.hubSync();
    assert.equal(you.item('Milk').state, 'out');
    assert.equal(you.recipe('Soup').length, 1);
    assert.match(you.toast(), /Partner updated 2 things/);
    await you.app.hubSync();
    assert.equal(you.app.__state().hub.state, 'synced');
  } finally { await h.stop(); }
});

test('when both edit the same item, the later change wins and can be undone', async () => {
  const h = await startHub();
  try {
    const you = await phone(h.base, YOU);
    you.app.addPantryItem({ name: 'Milk', location: 'fridge', state: 'some' });
    await you.app.hubSync();
    const partner = await phone(h.base, PARTNER);
    const milk = you.item('Milk').id;
    you.app.setPantryState(milk, 'low');
    partner.app.setPantryState(milk, 'plenty');
    await partner.app.hubSync();
    await you.app.hubSync();
    assert.equal(you.item('Milk').state, 'low', 'yours was later, so it stays');
    assert.match(you.toast(), /Partner had changed Milk/);
    assert.match(you.toast(), /hubUndoReplace/);
    you.app.hubUndoReplace();
    assert.equal(you.item('Milk').state, 'plenty');
    await you.app.hubSync();
    await partner.app.hubSync();
    assert.equal(partner.item('Milk').state, 'plenty');
  } finally { await h.stop(); }
});

test('two phones logging the same cook: the second is refused and its pantry changes roll back', async () => {
  const h = await startHub();
  try {
    const storage = offlinePhone({}, (app, { el }) => {
      app.addPantryItem({ name: 'Rice', location: 'pantry', state: 'plenty', amount: '4', unit: 'cup' });
      acceptWeek(app, el);
    });
    const you = await phone(h.base, YOU, storage);
    const partner = await phone(h.base, PARTNER);

    assert.equal(you.app.openCookSheet('Wednesday'), 'ready');
    assert.equal(you.app.applyCook(), 'applied');
    assert.equal(partner.app.openCookSheet('Wednesday'), 'ready');
    const rice = partner.app.__state().cookDraft.rows.find(row => /rice/.test(row.label));
    partner.app.updateCookRow(rice.rowId, 'amount', '1');
    assert.equal(partner.app.applyCook(), 'applied');
    assert.deepEqual(partner.item('Rice').qty, { amount: 3, unit: 'cup' });

    await you.app.hubSync();
    await partner.app.hubSync();
    assert.deepEqual(partner.item('Rice').qty, { amount: 2, unit: 'cup' }, 'the hub\'s rice (yours) replaces the refused deduction');
    const leftovers = partner.app.__state().pantryItems.filter(item => item.kind === 'leftover' && !item.archived);
    assert.equal(leftovers.length, 1, 'only the first cook\'s leftovers remain');
    assert.equal(partner.app.__state().actions.filter(action => action.kind === 'cooked' && !action.undoneAt).length, 1);
    assert.match(partner.toast(), /You already logged/);
    assert.equal(partner.app.openCookSheet('Wednesday'), 'duplicate', 'and the night now reads as cooked');
  } finally { await h.stop(); }
});

test('a phone with its own data asks before merging, backs up, then merges by name', async () => {
  const h = await startHub();
  try {
    const you = await phone(h.base, YOU);
    you.app.addPantryItem({ name: 'Milk', location: 'fridge', state: 'some' });
    you.app.addRecipe({ name: 'Tacos', ingredients: '8 tortillas' });
    await you.app.hubSync();

    const storage = offlinePhone({}, app => {
      app.addPantryItem({ name: 'milk', location: 'fridge', state: 'plenty' });
      app.addPantryItem({ name: 'Eggs', location: 'fridge', state: 'some' });
      app.addRecipe({ name: 'tacos', ingredients: '4 tortillas' });
      app.addRecipe({ name: 'Soup', ingredients: '1 cup lentils' });
      app.toggleFavorite(app.__state().recipes.find(recipe => recipe.name === 'tacos').id);
    });
    const partner = await phone(h.base, PARTNER, storage);
    assert.equal(partner.connected, 'merge');
    assert.equal(partner.app.__state().hub.state, 'merge');
    assert.match(partner.el('hubSheetBody').innerHTML, /hubMergeChoice\('merge'\)/);
    assert.equal(await partner.app.hubSync(), 'merge', 'nothing syncs until you choose');
    await you.app.hubSync();
    assert.equal(you.item('Eggs'), null);

    assert.equal(await partner.app.hubMergeChoice('merge'), 'merged');
    assert.ok(storage.fmp_hub_premerge_backup, 'this phone was backed up first');
    assert.equal(partner.item('Milk').state, 'plenty', 'the more recently confirmed level wins');
    assert.equal(partner.recipe('Tacos').length + partner.recipe('tacos').length, 1, 'recipes with the same name are combined');
    assert.equal(partner.recipe('Tacos')[0].favorite, true);
    await you.app.hubSync();
    assert.equal(you.item('Eggs').state, 'some');
    assert.equal(you.recipe('Soup').length, 1);
    assert.equal(you.item('Milk').state, 'plenty');
  } finally { await h.stop(); }
});

test('a lost sign-in is shown as an error, not silently ignored', async () => {
  const ctx = createApp({}, { fetch: async () => new Response(JSON.stringify({ error: 'Sign in' }), { status: 401, headers: { 'content-type': 'application/json' } }) });
  ctx.app.init();
  assert.equal(await ctx.app.__state().hubReady, 'error');
  assert.match(ctx.el('hubChip').innerHTML, /Sign in/);
});
