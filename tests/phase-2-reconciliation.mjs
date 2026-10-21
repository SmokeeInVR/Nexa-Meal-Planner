import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './helpers/load-app.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
const TUESDAY = new Date(2026, 9, 20, 12);
const WEDNESDAY = new Date(2026, 9, 21, 12);

function weekProposal() {
  return {
    format: 'nexa-meal-plan-proposal/v1',
    proposalId: 'phase-2-week',
    window: { start: '2026-10-21', end: '2026-10-27' },
    weeklyMealPlan: [
      { day: 'Wednesday', alsoEatenOn: 'Thursday', dinner: { name: 'Chicken rice bowls', ingredients: ['2 lb chicken thighs', '2 cups rice', '1 bunch cilantro', '2 bell peppers'] } },
      { day: 'Thursday', isLeftoverNight: true, dinner: { name: 'Chicken rice bowls' } },
      { day: 'Friday', dinner: { name: 'Bean tacos', ingredients: ['1 can black beans', '8 tortillas'] } },
    ],
    groceryList: {
      produce: [{ name: 'Cilantro', quantity: '1 bunch', estimatedPrice: 1.29 }, { name: 'Kale', quantity: '1 bunch' }, { name: 'Kale', quantity: '2 bunch' }],
      protein: [{ name: 'Chicken thighs', quantity: '2 lb', estimatedPrice: 7.5 }],
      pantry: [{ name: 'Black beans', quantity: '2 lb' }],
    },
    estimatedTotal: 9,
  };
}

// Fresh household with a tracked pantry and the week's plan accepted.
function household(storage) {
  const ctx = createApp(storage);
  ctx.app.init();
  const { app } = ctx;
  if (!storage) {
    app.addPantryItem({ name: 'Chicken', location: 'fridge', state: 'some', amount: '1', unit: 'lb' });
    app.addPantryItem({ name: 'Rice', location: 'pantry', state: 'plenty', amount: '4', unit: 'cup' });
    app.addPantryItem({ name: 'Black beans', location: 'pantry', state: 'some', amount: '1', unit: 'can' });
    app.addPantryItem({ name: 'Bell peppers', location: 'fridge', state: 'some' });
    ctx.el('proposalInput').value = JSON.stringify(weekProposal());
    app.checkProposal();
    assert.equal(app.acceptProposal(), 'accepted');
  }
  ctx.item = name => plain(app.__state().pantryItems.find(entry => entry.name === name && !entry.archived) ?? null);
  ctx.pantryJSON = () => JSON.stringify(app.__state().pantryItems);
  return ctx;
}

const row = (draft, text) => draft.rows.find(entry => entry.label.includes(text));

test('checking groceries off never changes stock', () => {
  const { app, pantryJSON } = household();
  const before = pantryJSON();
  app.toggleCheckByIndex(1, 0);
  app.toggleCheckByIndex(1, 0);
  app.toggleCheckByIndex(0, 0);
  assert.equal(pantryJSON(), before);
});

test('quantities parse and only compatible units combine', () => {
  const { app } = household();
  assert.deepEqual(plain(app.parseQuantityText('2 cups rice')), { amount: 2, unit: 'cup', rest: 'rice' });
  assert.deepEqual(plain(app.parseQuantityText('8 tortillas')), { amount: 8, unit: 'count', rest: 'tortillas' });
  assert.deepEqual(plain(app.parseQuantityText('1 1/2 lb ground beef')), { amount: 1.5, unit: 'lb', rest: 'ground beef' });
  assert.equal(app.parseQuantityText('salt to taste').amount, null);
  assert.deepEqual(plain(app.combineQty({ amount: 1, unit: 'lb' }, { amount: 2, unit: 'lb' })), { ok: true, qty: { amount: 3, unit: 'lb' } });
  assert.deepEqual(plain(app.combineQty({ amount: 1, unit: 'lb' }, { amount: 8, unit: 'oz' })), { ok: true, qty: { amount: 1.5, unit: 'lb' } });
  assert.equal(app.combineQty({ amount: 1, unit: 'can' }, { amount: 2, unit: 'lb' }).ok, false);
  assert.equal(app.combineQty({ amount: 1, unit: 'cup' }, { amount: 1, unit: 'lb' }).ok, false, 'volume never merges with weight');
  assert.deepEqual(plain(app.subtractQty({ amount: 4, unit: 'cup' }, { amount: 2, unit: 'cup' })), { ok: true, qty: { amount: 2, unit: 'cup' } });
  assert.deepEqual(plain(app.subtractQty({ amount: 1, unit: 'lb' }, { amount: 24, unit: 'oz' })), { ok: true, qty: { amount: 0, unit: 'lb' } });
});

test('put away: partial trips, unit merge, conflicts, new items, never twice', () => {
  const { app, item } = household();
  app.toggleCheckByIndex(0, 0); // Cilantro
  app.toggleCheckByIndex(1, 0); // Chicken thighs
  app.toggleCheckByIndex(2, 0); // Black beans
  assert.equal(app.openPutAway(), 3);
  const draft = app.__state().putAwayDraft;
  assert.equal(row(draft, 'Chicken thighs').itemId, item('Chicken').id);
  assert.equal(row(draft, 'Chicken thighs').mode, 'add');
  assert.equal(row(draft, 'Black beans').mode, 'replace', 'incompatible units default to replace');
  assert.equal(row(draft, 'Black beans').conflict, true);
  assert.equal(row(draft, 'Cilantro').itemId, '', 'unknown grocery becomes a new item');
  assert.equal(row(draft, 'Cilantro').location, 'fridge');
  assert.equal(item('Chicken').qty.amount, 1, 'preview alone changes nothing');

  assert.equal(app.applyPutAway(), 'applied');
  assert.deepEqual(item('Chicken').qty, { amount: 3, unit: 'lb' });
  assert.equal(item('Chicken').state, 'plenty');
  assert.deepEqual(item('Black beans').qty, { amount: 2, unit: 'lb' });
  assert.deepEqual(item('Cilantro').qty, { amount: 1, unit: 'bunch' });
  assert.equal(item('Cilantro').location, 'fridge');
  assert.ok(item('Cilantro').lastConfirmedAt);
  assert.equal(app.applyPutAway(), 'none', 'a second tap does nothing');

  assert.equal(app.openPutAway(), 0, 'nothing left to put away');
  app.toggleCheckByIndex(0, 0);
  app.toggleCheckByIndex(0, 0);
  assert.equal(app.openPutAway(), 0, 're-checking a put-away item does not offer it again');

  app.toggleCheckByIndex(0, 2); // second Kale
  assert.equal(app.openPutAway(), 1);
  const kale = app.__state().putAwayDraft.rows[0];
  assert.match(kale.label, /Kale/);
  app.updatePutAwayRow(kale.rowId, 'action', 'ignore');
  assert.equal(app.applyPutAway(), 'applied');
  assert.equal(item('Kale'), null, '"not tracked" adds nothing to the pantry');
  assert.equal(app.openPutAway(), 0);
});

test('put away keeps skipped ("later") rows for next time', () => {
  const { app } = household();
  app.toggleCheckByIndex(0, 0);
  app.openPutAway();
  const cilantro = app.__state().putAwayDraft.rows[0];
  app.updatePutAwayRow(cilantro.rowId, 'action', 'later');
  assert.equal(app.applyPutAway(), 'none');
  assert.equal(app.openPutAway(), 1);
});

test('grocery check-offs no longer collide on duplicate names and keep old keys', () => {
  const { app } = household();
  assert.equal(app.groceryKey('produce', 1), 'Kale');
  assert.equal(app.groceryKey('produce', 2), 'Kale#2');
  app.toggleCheckByIndex(0, 2);
  const checked = plain(app.__state().checkedItems);
  assert.equal(checked.produce['Kale#2'], true);
  assert.equal(checked.produce.Kale, undefined, 'the first Kale stays unchecked');
});

test('cooking deducts compatible amounts, sets Out at zero, and leaves untracked items alone', () => {
  const { app, item } = household();
  const peppersConfirmed = item('Bell peppers').lastConfirmedAt;
  assert.equal(app.openCookSheet('Wednesday'), 'ready');
  const draft = app.__state().cookDraft;
  assert.equal(row(draft, 'rice').mode, 'deduct');
  assert.equal(row(draft, 'cilantro').mode, 'none');
  assert.equal(row(draft, 'bell peppers').mode, 'level');
  assert.equal(row(draft, 'bell peppers').level, '', 'untracked amount defaults to no change');
  assert.equal(draft.leftover.create, true, 'a batch night suggests leftovers');
  assert.equal(draft.leftover.useBy, '', 'no automatic use-by date');
  assert.equal(item('Rice').qty.amount, 4, 'preview alone changes nothing');

  assert.equal(app.applyCook(), 'applied');
  assert.deepEqual(item('Rice').qty, { amount: 2, unit: 'cup' });
  assert.equal(item('Chicken').state, 'out');
  assert.equal(item('Chicken').qty, null);
  assert.equal(item('Bell peppers').state, 'some');
  assert.equal(item('Bell peppers').lastConfirmedAt, peppersConfirmed);
  assert.equal(item('Cilantro'), null);

  const leftovers = plain(app.__state().pantryItems.find(entry => entry.kind === 'leftover'));
  assert.equal(leftovers.name, 'Leftovers: Chicken rice bowls');
  assert.equal(leftovers.portions, 2);
  assert.match(leftovers.cookedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(leftovers.bestBy, null);

  assert.equal(app.openCookSheet('Wednesday'), 'duplicate');
  assert.equal(app.applyCook(), 'none');
  assert.deepEqual(item('Rice').qty, { amount: 2, unit: 'cup' }, 'no double deduction');
});

test('cook preview edits: chosen level applies, estimated use-by is labeled', () => {
  const { app, item } = household();
  app.openCookSheet('Wednesday');
  const draft = app.__state().cookDraft;
  app.updateCookRow(row(draft, 'bell peppers').rowId, 'level', 'low');
  app.updateCookRow(row(draft, 'rice').rowId, 'include', false);
  app.setLeftoverUseBy(3, WEDNESDAY);
  app.setLeftoverField('portions', '4');
  assert.equal(app.applyCook(), 'applied');
  assert.equal(item('Bell peppers').state, 'low');
  assert.deepEqual(item('Rice').qty, { amount: 4, unit: 'cup' }, 'a skipped row changes nothing');
  const leftovers = item('Leftovers: Chicken rice bowls');
  assert.deepEqual(leftovers.bestBy, { value: '2026-10-24', source: 'estimated' });
  assert.equal(leftovers.portions, 4);
  assert.match(app.pantryMeta(leftovers, WEDNESDAY), /est\./);
});

test('eating leftovers removes portions and clears the entry at zero', () => {
  const { app, item } = household();
  app.openCookSheet('Wednesday');
  app.setLeftoverField('portions', '4');
  app.applyCook();
  assert.equal(app.openAteSheet('Thursday'), 'ready');
  assert.equal(app.__state().ateDraft.portions, 2);
  assert.equal(app.applyAte(), 'applied');
  assert.equal(item('Leftovers: Chicken rice bowls').portions, 2);
  assert.equal(app.openAteSheet('Thursday'), 'duplicate');

  const { item: leftovers } = { item: item('Leftovers: Chicken rice bowls') };
  app.setLeftoverPortions(leftovers.id, -2);
  assert.equal(item('Leftovers: Chicken rice bowls'), null, 'zero portions removes it from the list');
  app.undoPantryChange();
  assert.equal(item('Leftovers: Chicken rice bowls').portions, 2);
});

test('leftover night with nothing logged explains instead of guessing', () => {
  const { app } = household();
  assert.equal(app.openAteSheet('Thursday'), 'no-leftovers');
});

test('undo of a cook restores items and reports ones edited since', () => {
  const { app, item } = household();
  app.openCookSheet('Wednesday');
  app.applyCook();
  const cook = plain(app.__state().actions[0]);
  app.setPantryState(item('Rice').id, 'plenty');
  const result = plain(app.undoAction(cook.id));
  assert.equal(result.status, 'undone');
  assert.deepEqual(result.conflicts, ['Rice']);
  assert.deepEqual(item('Rice').qty, { amount: 2, unit: 'cup' }, 'edited item left as is');
  assert.equal(item('Chicken').state, 'some');
  assert.deepEqual(item('Chicken').qty, { amount: 1, unit: 'lb' });
  assert.equal(app.__state().pantryItems.some(entry => entry.kind === 'leftover' && !entry.archived), false);
  assert.equal(plain(app.undoAction(cook.id)).status, 'none', 'undo applies once');
  assert.equal(app.openCookSheet('Wednesday'), 'ready', 'an undone cook can be logged again');
});

test('skipping a night needs no stock change and can be undone', () => {
  const { app, el, pantryJSON } = household();
  const before = pantryJSON();
  assert.equal(app.skipNight('Friday'), 'skipped');
  assert.equal(app.skipNight('Friday'), 'duplicate');
  assert.equal(pantryJSON(), before);
  app.renderHome(TUESDAY);
  assert.doesNotMatch(el('homeContent').innerHTML, /Friday: Bean tacos/);
  app.undoAction(app.__state().actions[0].id);
  app.renderHome(new Date(2026, 9, 22, 12));
  assert.match(el('homeContent').innerHTML, /Friday: Bean tacos/);
});

test('home respects the plan window and shows what was done', () => {
  const { app, el } = household();
  app.renderHome(TUESDAY);
  assert.match(el('homeContent').innerHTML, /Plan starts Wed/);
  assert.doesNotMatch(el('homeContent').innerHTML, /Tonight&#39;s dinner|Tonight's dinner/);
  app.renderHome(WEDNESDAY);
  assert.match(el('homeContent').innerHTML, /We cooked this/);
  app.openCookSheet('Wednesday');
  app.applyCook();
  app.renderHome(WEDNESDAY);
  assert.match(el('homeContent').innerHTML, /Cooked ✓/);
  assert.match(el('homeContent').innerHTML, /Done recently/);
});

test('packet lists leftovers separately and coverage ignores them', () => {
  const { app } = household();
  app.openCookSheet('Wednesday');
  app.applyCook();
  const packet = app.buildPlanningPacket(TUESDAY);
  assert.match(packet, /Leftovers: Chicken rice bowls \(2 portions/);
  assert.doesNotMatch(packet, /plenty: [^\n]*Leftovers/);
});

test('actions, put-away state and leftovers survive a reload', () => {
  const ctx = household();
  ctx.app.toggleCheckByIndex(0, 0);
  ctx.app.openPutAway();
  ctx.app.applyPutAway();
  ctx.app.openCookSheet('Wednesday');
  ctx.app.applyCook();
  const reloaded = household(ctx.storage);
  assert.equal(reloaded.app.__state().actions.length, 2);
  assert.equal(reloaded.app.openPutAway(), 0);
  assert.equal(reloaded.app.openCookSheet('Wednesday'), 'duplicate');
  assert.equal(reloaded.item('Leftovers: Chicken rice bowls').portions, 2);
  const cook = reloaded.app.__state().actions.find(action => action.kind === 'cooked');
  assert.deepEqual(plain(reloaded.app.undoAction(cook.id)).conflicts, [], 'reload does not cause false conflicts');
});
