import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './helpers/load-app.mjs';

const DAY = 24 * 60 * 60 * 1000;
// Values cross the vm realm boundary, so compare plain JSON copies.
const plain = value => JSON.parse(JSON.stringify(value));
const TUESDAY = new Date(2026, 9, 20, 12);
const WEDNESDAY = new Date(2026, 9, 21, 12);

function proposal(overrides = {}) {
  return {
    format: 'nexa-meal-plan-proposal/v1',
    proposalId: 'wk-2026-10-21',
    window: { start: '2026-10-21', end: '2026-10-27' },
    weeklyMealPlan: [
      { day: 'Wednesday', isLeftoverNight: false, alsoEatenOn: 'Thursday', dinner: { name: 'Chicken rice bowls', ingredients: ['2 lb chicken thighs', '2 cups rice', '1 bunch cilantro'], steps: ['Cook rice', 'Roast chicken'] } },
      { day: 'Thursday', isLeftoverNight: true, dinner: { name: 'Chicken rice bowls' } },
    ],
    groceryList: {
      produce: [{ name: 'Cilantro', quantity: '1 bunch', estimatedPrice: 1.29 }],
      protein: [{ name: 'Chicken thighs', quantity: '2 lb', estimatedPrice: 7.5 }],
    },
    estimatedTotal: 8.79,
    ...overrides,
  };
}

function freshApp(storage) {
  const ctx = createApp(storage);
  ctx.app.init();
  return ctx;
}

function review(ctx, value) {
  ctx.el('proposalInput').value = typeof value === 'string' ? value : JSON.stringify(value);
  ctx.app.checkProposal();
  return ctx.app.__state().pendingProposal;
}

test('fresh profile tracks nothing and the packet says so', () => {
  const { app } = freshApp();
  assert.equal(app.__state().pantryItems.length, 0);
  const packet = app.buildPlanningPacket(TUESDAY);
  assert.match(packet, /nothing recorded yet/i);
  assert.doesNotMatch(packet, /plenty: chicken/i);
});

test('legacy pantry migrates honestly and keeps a backup', () => {
  const legacyStatus = { chicken: 'plenty', rice: 'some', eggs: 'out' };
  const storage = {
    fmp_pantry: JSON.stringify(legacyStatus),
    fmp_pantry_qty: JSON.stringify({ chicken: '2|lbs', eggs: '12|count' }),
  };
  const { app } = freshApp(storage);
  const items = plain(app.__state().pantryItems);
  const byName = name => items.find(item => item.name === name);
  assert.equal(items.length, 3);
  assert.equal(byName('chicken').state, 'plenty');
  assert.deepEqual(byName('chicken').qty, { amount: 2, unit: 'lb' });
  assert.equal(byName('chicken').lastConfirmedAt, null, 'carried-over stock is not confirmed');
  assert.equal(byName('chicken').migrated, true);
  assert.equal(byName('rice').state, 'unknown', 'old default "some" cannot be trusted');
  assert.equal(byName('eggs').state, 'out');
  assert.equal(byName('eggs').qty, null);

  const backup = JSON.parse(storage.fmp_pantry_v1_backup);
  assert.equal(backup.fmp_pantry, storage.fmp_pantry);
  assert.equal(storage.fmp_pantry, JSON.stringify(legacyStatus), 'legacy key left untouched');

  const reloaded = freshApp(storage).app;
  assert.deepEqual(plain(reloaded.__state().pantryItems).map(item => item.id), items.map(item => item.id), 'migration runs once');
});

test('setting a state confirms it; out clears quantity; unknown clears confirmation', () => {
  const { app } = freshApp();
  const added = app.addPantryItem({ name: 'Milk', location: 'fridge', state: 'some', amount: '1', unit: 'gal' });
  assert.equal(added.ok, true);
  const id = added.item.id;
  const milk = () => plain(app.__state().pantryItems.find(item => item.id === id));
  assert.ok(milk().lastConfirmedAt);
  assert.deepEqual(milk().qty, { amount: 1, unit: 'gal' });

  app.setPantryState(id, 'out');
  assert.equal(milk().state, 'out');
  assert.equal(milk().qty, null);

  app.setPantryState(id, 'unknown');
  assert.equal(milk().lastConfirmedAt, null);
});

test('quantities and units normalize; unreadable amounts are rejected', () => {
  const { app } = freshApp();
  assert.equal(app.normalizeUnit('lbs'), 'lb');
  assert.equal(app.normalizeUnit('Pounds'), 'lb');
  assert.equal(app.normalizeUnit('handful'), '');
  assert.equal(app.parseAmount('1/2'), 0.5);
  assert.equal(app.parseAmount('1 1/2'), 1.5);
  assert.equal(app.parseAmount('2.25'), 2.25);
  assert.equal(app.parseAmount('lots'), null);
  const bad = app.addPantryItem({ name: 'Rice', state: 'some', amount: 'lots', unit: 'lb' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /number/);
  assert.equal(app.__state().pantryItems.length, 0);
});

test('duplicate names are refused and custom names render as text', () => {
  const { app, el } = freshApp();
  assert.equal(app.addPantryItem({ name: 'Oat milk', state: 'some' }).ok, true);
  const dup = app.addPantryItem({ name: 'oat MILK', state: 'low' });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /already/);

  assert.equal(app.addPantryItem({ name: '<img src=x onerror="bad">\'', state: 'some' }).ok, true);
  const listHTML = el('pantryList').innerHTML;
  assert.ok(!listHTML.includes('<img'), 'markup in a name must not render');
  assert.ok(listHTML.includes('&lt;img'));
});

test('undo restores the previous pantry state', () => {
  const { app } = freshApp();
  const { item } = app.addPantryItem({ name: 'Milk', location: 'fridge', state: 'some', amount: '2', unit: 'l' });
  app.setPantryState(item.id, 'out');
  app.undoPantryChange();
  const milk = plain(app.__state().pantryItems.find(entry => entry.id === item.id));
  assert.equal(milk.state, 'some');
  assert.deepEqual(milk.qty, { amount: 2, unit: 'l' });

  const added = app.addPantryItem({ name: 'Tortillas', state: 'plenty' });
  app.undoPantryChange();
  assert.ok(!app.__state().pantryItems.some(entry => entry.id === added.item.id), 'undo removes a just-added item');
});

test('stale or unconfirmed items need a check; estimated dates are labeled', () => {
  const { app } = freshApp();
  const { item } = app.addPantryItem({ name: 'Yogurt', location: 'fridge', state: 'some', bestBy: { value: '2026-10-25', source: 'estimated' } });
  const live = app.__state().pantryItems.find(entry => entry.id === item.id);
  assert.equal(app.needsCheck(live, new Date()), false);
  live.lastConfirmedAt = new Date(Date.now() - 10 * DAY).toISOString();
  assert.equal(app.needsCheck(live, new Date()), true);
  assert.match(app.pantryMeta(live, new Date()), /est\./);

  const entered = app.addPantryItem({ name: 'Cheese', state: 'some', bestBy: { value: '2026-10-30', source: 'entered' } }).item;
  assert.doesNotMatch(app.pantryMeta(entered, new Date()), /est\./);
  assert.equal(app.needsCheck(app.addPantryItem({ name: 'Flour' }).item, new Date()), true, 'unknown state needs a check');
});

test('packet targets the upcoming Wednesday window and carries quantities and meal types', () => {
  const { app } = freshApp();
  assert.deepEqual(plain(app.upcomingWindow(TUESDAY)), { start: '2026-10-21', end: '2026-10-27' });
  assert.deepEqual(plain(app.upcomingWindow(WEDNESDAY)), { start: '2026-10-21', end: '2026-10-27' });

  app.addPantryItem({ name: 'Milk', location: 'fridge', state: 'low', amount: '1', unit: 'gal' });
  app.addPantryItem({ name: 'Flour', location: 'pantry' });
  app.setMealType('breakfast', true);
  const packet = app.buildPlanningPacket(TUESDAY);
  assert.match(packet, /2026-10-21 to 2026-10-27/);
  assert.match(packet, /low: Milk \(1 gal/);
  assert.match(packet, /do not assume[^\n]*Flour/i);
  assert.match(packet, /breakfast ideas: yes/i);
  assert.match(packet, /nexa-meal-plan-proposal\/v1/);
});

test('proposal validation blocks broken input and warns about soft issues', () => {
  const ctx = freshApp();
  assert.match(review(ctx, 'sounds good!').errors.join(' '), /JSON/);
  assert.match(review(ctx, '{"weeklyMealPlan": [').errors.join(' '), /JSON/);
  assert.match(review(ctx, proposal({ weeklyMealPlan: [] })).errors.join(' '), /at least one night/);

  const badDay = proposal();
  badDay.weeklyMealPlan[0].day = 'Funday';
  assert.match(review(ctx, badDay).errors.join(' '), /Funday/);

  const twice = proposal();
  twice.weeklyMealPlan[1].day = 'Wednesday';
  assert.match(review(ctx, twice).errors.join(' '), /twice/);

  const noName = proposal();
  noName.weeklyMealPlan[0].dinner.name = '';
  assert.equal(review(ctx, noName).ok, false);

  const soft = proposal({ groceryList: { frozen: [{ name: 'Peas' }] } });
  const result = review(ctx, soft);
  assert.equal(result.ok, true);
  assert.match(result.warnings.join(' '), /frozen/);
  assert.match(result.warnings.join(' '), /no price estimate/);
  assert.equal(result.plan.groceryList.frozen.length, 1);

  ctx.app.__set('otherExcl', 'cilantro');
  assert.match(review(ctx, proposal()).warnings.join(' '), /cilantro/);

  const fenced = `Here is the plan:\n\`\`\`json\n${JSON.stringify(proposal())}\n\`\`\`\nEnjoy!`;
  assert.equal(review(ctx, fenced).ok, true);
});

test('reviewed plan round trip: preview, accept, duplicate, replace, undo, discard, reload', () => {
  const ctx = freshApp();
  const { app, el, storage } = ctx;
  app.addPantryItem({ name: 'Rice', location: 'pantry', state: 'plenty' });
  const pending = review(ctx, proposal());
  assert.equal(pending.ok, true);
  const preview = el('proposalPreview').innerHTML;
  assert.match(preview, /waiting for your approval/i);
  assert.match(preview, /Accept plan/);
  assert.match(preview, /2 cups rice[\s\S]*?on hand/);
  assert.match(preview, /1 bunch cilantro[\s\S]*?on list/);
  assert.match(preview, /2 lb chicken thighs[\s\S]*?on list/);
  assert.equal(app.__state().mealPlan, null, 'review alone never activates a plan');

  assert.equal(app.acceptProposal(), 'accepted');
  assert.equal(app.acceptProposal(), 'none', 'a second tap does nothing');
  assert.equal(app.__state().mealPlan.weeklyMealPlan.length, 2);
  assert.ok(storage.fmp_plan);
  assert.equal(app.__state().mealHistory.length, 0);
  app.toggleCheck('produce', 'Cilantro');

  review(ctx, proposal());
  assert.equal(app.acceptProposal(), 'duplicate');
  assert.equal(app.__state().mealHistory.length, 0);
  assert.equal(app.__state().checkedItems.produce.Cilantro, true, 'duplicate accept keeps check-offs');

  const second = proposal({ proposalId: 'wk-2', weeklyMealPlan: [{ day: 'Wednesday', dinner: { name: 'Lentil soup', ingredients: ['1 cup lentils'] } }] });
  review(ctx, second);
  assert.equal(app.acceptProposal(), 'accepted');
  assert.equal(app.__state().mealHistory.length, 1);
  assert.deepEqual(plain(app.__state().mealHistory[0].cookMealNames), ['Chicken rice bowls']);
  assert.deepEqual(plain(app.__state().checkedItems), {});

  assert.equal(app.undoAccept(), 'undone');
  assert.equal(app.__state().mealPlan.weeklyMealPlan[0].dinner.name, 'Chicken rice bowls');
  assert.equal(app.__state().checkedItems.produce.Cilantro, true);
  assert.equal(app.__state().mealHistory.length, 0);
  assert.equal(app.undoAccept(), 'none', 'undo applies once');

  review(ctx, second);
  app.discardProposal();
  assert.equal(app.__state().pendingProposal, null);
  assert.equal(app.__state().mealPlan.weeklyMealPlan[0].dinner.name, 'Chicken rice bowls');

  const reloaded = freshApp(storage).app;
  assert.equal(reloaded.__state().mealPlan.weeklyMealPlan[0].dinner.name, 'Chicken rice bowls');
  assert.equal(reloaded.__state().checkedItems.produce.Cilantro, true);
  assert.ok(reloaded.__state().pantryItems.some(item => item.name === 'Rice'));
});

test('carried-over stock is never treated as on hand in the preview', () => {
  const ctx = freshApp({ fmp_pantry: JSON.stringify({ rice: 'plenty' }) });
  review(ctx, proposal());
  assert.match(ctx.el('proposalPreview').innerHTML, /2 cups rice<em>not confirmed/);
});

test('a proposal with errors cannot be accepted', () => {
  const ctx = freshApp();
  review(ctx, proposal({ weeklyMealPlan: [] }));
  assert.equal(ctx.app.acceptProposal(), 'blocked');
  assert.equal(ctx.app.__state().mealPlan, null);
  assert.match(ctx.el('proposalPreview').innerHTML, /can(&#39;|')t be accepted/);
});

test('shopping shows every category and labels prices as estimates', () => {
  const ctx = freshApp();
  review(ctx, proposal({ groceryList: { frozen: [{ name: 'Peas', estimatedPrice: 2 }], produce: [{ name: 'Kale' }] } }));
  ctx.app.acceptProposal();
  const shopping = ctx.el('shoppingContent').innerHTML;
  assert.match(shopping, /Peas/);
  assert.match(shopping, /Frozen/);
  assert.match(shopping, /~\$2\.00/);
  assert.match(shopping, /no est\./);
});

test('meal-type choices persist', () => {
  const { app, storage } = freshApp();
  app.setMealType('snacks', false);
  const reloaded = freshApp(storage).app;
  assert.equal(reloaded.__state().mealTypes.snacks, false);
});
