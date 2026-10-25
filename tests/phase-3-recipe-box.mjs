import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './helpers/load-app.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
const TUESDAY = new Date(2026, 9, 20, 12);

function fresh(storage) {
  const ctx = createApp(storage);
  ctx.app.init();
  ctx.recipe = name => plain(ctx.app.__state().recipes.find(entry => entry.name === name && !entry.deleted) ?? null);
  ctx.item = name => plain(ctx.app.__state().pantryItems.find(entry => entry.name === name && !entry.archived) ?? null);
  return ctx;
}

const tacos = {
  name: 'Chicken tacos', servings: '4', minutes: '30', cuisine: 'Mexican',
  ingredients: '2 lb chicken thighs\n8 tortillas\n1 cup rice\nsalt to taste',
  steps: 'Season the chicken\nSear for 6 minutes per side\nRest 5 min, then slice',
  videoUrl: 'https://www.youtube.com/watch?v=abc123',
};

test('recipe input is validated: name, ingredients, safe links, numbers', () => {
  const { app } = fresh();
  assert.equal(app.validateRecipeInput({ ...tacos, name: '' }).ok, false);
  assert.equal(app.validateRecipeInput({ ...tacos, ingredients: '  \n ' }).ok, false);
  assert.match(app.validateRecipeInput({ ...tacos, videoUrl: 'javascript:alert(1)' }).error, /link/i);
  assert.match(app.validateRecipeInput({ ...tacos, videoUrl: 'http://example.com/x' }).error, /link/i);
  assert.equal(app.validateRecipeInput({ ...tacos, servings: '0' }).ok, false);
  const ok = app.validateRecipeInput({ ...tacos, ingredients: ' 2 lb chicken thighs \n\n8 tortillas ' });
  assert.equal(ok.ok, true);
  assert.deepEqual(plain(ok.value.ingredients), ['2 lb chicken thighs', '8 tortillas']);
  assert.equal(app.validateRecipeInput({ name: 'Leftover fried rice', ingredients: 'rice\neggs', quick: true }).ok, true, 'a quick "we just made this" needs no steps');
});

test('recipes are added, edited, favourited, deleted with undo, and persist', () => {
  const ctx = fresh();
  const { app, storage } = ctx;
  assert.equal(app.addRecipe(tacos).ok, true);
  assert.match(app.addRecipe({ ...tacos, name: 'chicken TACOS' }).error, /already/);
  const id = ctx.recipe('Chicken tacos').id;
  assert.equal(app.updateRecipe(id, { ...tacos, minutes: '25', notes: 'Extra lime' }).ok, true);
  assert.equal(ctx.recipe('Chicken tacos').minutes, 25);
  app.toggleFavorite(id);
  assert.equal(ctx.recipe('Chicken tacos').favorite, true);
  app.deleteRecipe(id);
  assert.equal(ctx.recipe('Chicken tacos'), null);
  app.undoRecipeDelete();
  assert.equal(ctx.recipe('Chicken tacos').notes, 'Extra lime');
  const reloaded = fresh(storage);
  assert.equal(reloaded.recipe('Chicken tacos').favorite, true);
  assert.equal(reloaded.recipe('Chicken tacos').videoUrl, tacos.videoUrl);
});

test('ingredients scale cleanly and leave unmeasured lines alone', () => {
  const { app } = fresh();
  assert.equal(app.scaleIngredient('2 cups rice', 1.5), '3 cups rice');
  assert.equal(app.scaleIngredient('1/2 cup milk', 2), '1 cup milk');
  assert.equal(app.scaleIngredient('1 lb chicken', 0.5), '1/2 lb chicken');
  assert.equal(app.scaleIngredient('8 tortillas', 0.5), '4 tortillas');
  assert.equal(app.scaleIngredient('1 can black beans', 2), '2 cans black beans');
  assert.equal(app.scaleIngredient('salt to taste', 2), 'salt to taste');
  assert.equal(app.scaleIngredient('2 cups rice', 1), '2 cups rice', 'unscaled lines are untouched');
});

test('cards use illustrations without photos and escape names', () => {
  const { app, el } = fresh();
  const art = app.recipeArt({ name: 'Chicken tacos', cuisine: 'Mexican', ingredients: ['2 lb chicken'] });
  assert.equal(art.emoji, '🌮');
  assert.deepEqual(plain(app.recipeArt({ name: 'Chicken tacos', cuisine: 'Mexican', ingredients: [] })), plain(art), 'art is stable for a recipe');
  assert.equal(app.recipeArt({ name: 'Weeknight bowl', ingredients: ['1 lb salmon'] }).emoji, '🐟');
  app.addRecipe({ ...tacos, name: '<img src=x onerror="bad">' });
  app.setRecipeView('box');
  const html = el('recipesContent').innerHTML;
  assert.ok(!html.includes('<img src=x'), 'names render as text');
  assert.match(html, /recipe-tile/);
  assert.match(html, /recipe-art/);
});

test('photos fail gracefully where the device cannot store them', async () => {
  const ctx = fresh();
  ctx.app.addRecipe(tacos);
  const id = ctx.recipe('Chicken tacos').id;
  assert.equal(await ctx.app.attachRecipePhoto(id, { type: 'image/jpeg', size: 1000 }), 'unavailable');
  assert.equal(ctx.recipe('Chicken tacos').hasPhoto, false);
});

function acceptWeek(ctx, overrides = {}) {
  ctx.el('proposalInput').value = JSON.stringify({
    format: 'nexa-meal-plan-proposal/v1', proposalId: 'p3', window: { start: '2026-10-21', end: '2026-10-27' },
    weeklyMealPlan: [{ day: 'Friday', dinner: { name: 'Lentil soup', ingredients: ['1 cup lentils'], steps: ['Simmer 25 minutes'], nutritionPerServing: { calories: 410, protein: 22, carbs: 60, fat: 8 } } }],
    groceryList: { produce: [{ name: 'Carrots', quantity: '1 lb', estimatedPrice: 1.5 }] },
    estimatedTotal: 1.5, ...overrides,
  });
  ctx.app.checkProposal(TUESDAY);
  return ctx.app.__state().pendingProposal;
}

test('NEXA meals can be saved to the box once, with estimated nutrition labelled', () => {
  const ctx = fresh();
  acceptWeek(ctx);
  assert.equal(ctx.app.acceptProposal(), 'accepted');
  assert.equal(ctx.app.addNightToBox('Friday'), 'saved');
  assert.equal(ctx.app.addNightToBox('Friday'), 'duplicate');
  const soup = ctx.recipe('Lentil soup');
  assert.equal(soup.source, 'nexa');
  assert.deepEqual(soup.nutrition, { calories: 410, protein: 22, carbs: 60, fat: 8, source: 'estimated' });
  ctx.app.openRecipe(soup.id);
  assert.match(ctx.el('recipeSheetBody').innerHTML, /NEXA estimate/);
});

test('week picks: groceries come from the app, minus confirmed pantry stock', () => {
  const ctx = fresh();
  const { app } = ctx;
  app.addPantryItem({ name: 'Rice', location: 'pantry', state: 'plenty', amount: '4', unit: 'cup' });
  app.addPantryItem({ name: 'Tortillas', location: 'pantry', state: 'some' });
  app.addPantryItem({ name: 'Chicken', location: 'fridge', state: 'unknown' });
  app.addRecipe(tacos);
  app.addRecipe({ name: 'Chicken stir fry', servings: '2', ingredients: '1 lb chicken breast\n1 cup broccoli', steps: 'Stir fry 10 minutes' });
  app.setWeekPick('Wednesday', { type: 'recipe', recipeId: ctx.recipe('Chicken tacos').id }, TUESDAY);
  app.setWeekPick('Thursday', { type: 'leftovers' }, TUESDAY);
  app.setWeekPick('Saturday', { type: 'recipe', recipeId: ctx.recipe('Chicken stir fry').id }, TUESDAY);

  const list = plain(app.buildPickGroceries(TUESDAY));
  const buy = name => list.buy.find(entry => entry.name.toLowerCase().includes(name));
  // Tacos serve 4 but we cook for 2 → halved.
  assert.equal(buy('chicken').quantity, '2 lb', 'compatible chicken lines merge (1 lb + 1 lb)');
  assert.ok(list.onHand.some(entry => /rice/i.test(entry.name)), 'confirmed rice with enough amount is not bought');
  assert.ok(list.check.some(entry => /tortillas/i.test(entry.name)), 'confirmed stock without an amount asks for a check');
  assert.equal(buy('salt'), undefined, 'unmeasured "to taste" lines are not bought');
  assert.ok(buy('broccoli'));

  const packet = app.buildPlanningPacket(TUESDAY);
  assert.match(packet, /Already chosen[^\n]*\n[\s\S]*Wednesday: Chicken tacos/);
  assert.match(packet, /Thursday: leftovers/i);
  assert.match(packet, /Fill only: Friday, Sunday, Monday, Tuesday/);
});

test('a plan can be made from picks alone, then accepted like any proposal', () => {
  const ctx = fresh();
  const { app } = ctx;
  app.addRecipe(tacos);
  app.setWeekPick('Wednesday', { type: 'recipe', recipeId: ctx.recipe('Chicken tacos').id }, TUESDAY);
  app.setWeekPick('Thursday', { type: 'leftovers' }, TUESDAY);
  assert.equal(app.buildPlanFromPicks(TUESDAY), 'ready');
  const pending = app.__state().pendingProposal;
  assert.equal(pending.ok, true);
  assert.equal(app.__state().mealPlan, null, 'nothing is active before accepting');
  assert.equal(app.acceptProposal(), 'accepted');
  const plan = plain(app.__state().mealPlan);
  assert.equal(plan.weeklyMealPlan[0].dinner.recipeId, ctx.recipe('Chicken tacos').id);
  assert.equal(plan.weeklyMealPlan[0].alsoEatenOn, 'Thursday');
  assert.equal(plan.weeklyMealPlan[1].isLeftoverNight, true);
  assert.ok(Object.values(plan.groceryList).flat().some(item => /chicken/i.test(item.name)));
});

test('NEXA proposals merge with picks; picks win on clashes', () => {
  const ctx = fresh();
  const { app } = ctx;
  app.addRecipe(tacos);
  app.setWeekPick('Wednesday', { type: 'recipe', recipeId: ctx.recipe('Chicken tacos').id }, TUESDAY);
  const result = acceptWeek(ctx, {
    weeklyMealPlan: [
      { day: 'Wednesday', dinner: { name: 'Something else', ingredients: ['1 cup rice'] } },
      { day: 'Friday', dinner: { name: 'Lentil soup', ingredients: ['1 cup lentils'] } },
    ],
  });
  assert.equal(result.ok, true);
  assert.match(result.warnings.join(' '), /Wednesday is already chosen/);
  const days = result.plan.weeklyMealPlan.map(night => `${night.day}:${night.dinner.name}`);
  assert.deepEqual(plain(days), ['Wednesday:Chicken tacos', 'Friday:Lentil soup']);
  const groceries = Object.values(result.plan.groceryList).flat().map(item => item.name.toLowerCase());
  assert.ok(groceries.includes('carrots') && groceries.some(name => name.includes('chicken')));
});

test('cook mode steps through, finds timers, and logs a box recipe once a day', () => {
  const ctx = fresh();
  const { app } = ctx;
  assert.deepEqual(plain(app.detectTimers('Simmer for 20 minutes, stirring')), [1200]);
  assert.deepEqual(plain(app.detectTimers('Bake 1 hour, then rest 10 min')), [3600, 600]);
  assert.deepEqual(plain(app.detectTimers('Cook 10-12 minutes')), [600]);
  assert.deepEqual(plain(app.detectTimers('Serve warm')), []);

  app.addPantryItem({ name: 'Rice', location: 'pantry', state: 'plenty', amount: '4', unit: 'cup' });
  app.addRecipe(tacos);
  const id = ctx.recipe('Chicken tacos').id;
  assert.equal(app.openCookMode({ recipeId: id }), 'ready');
  assert.equal(app.__state().cookModeState.index, 0);
  app.cookModeStep(-1);
  assert.equal(app.__state().cookModeState.index, 0, 'cannot go before the first step');
  app.cookModeStep(1); app.cookModeStep(1); app.cookModeStep(1);
  assert.equal(app.__state().cookModeState.index, 2, 'cannot go past the last step');
  assert.match(ctx.el('cookModeBody').innerHTML, /Rest 5 min/);
  assert.equal(app.finishCookMode(), 'ready');
  const rice = app.__state().cookDraft.rows.find(row => /rice/.test(row.label));
  assert.equal(rice.label, '1/2 cup rice', 'cooking at household servings scales the ingredients');
  assert.equal(app.applyCook(), 'applied');
  assert.deepEqual(ctx.item('Rice').qty, { amount: 3.5, unit: 'cup' });
  app.openCookMode({ recipeId: id });
  assert.equal(app.finishCookMode(), 'duplicate');
});

test('grocery reset can be undone', () => {
  const ctx = fresh();
  acceptWeek(ctx);
  ctx.app.acceptProposal();
  ctx.app.toggleCheckByIndex(0, 0);
  ctx.app.resetShopping();
  assert.deepEqual(plain(ctx.app.__state().checkedItems), {});
  ctx.app.undoResetShopping();
  assert.equal(ctx.app.__state().checkedItems.produce.Carrots, true);
});

test('pantry search filters the list', () => {
  const { app, el } = fresh();
  app.addPantryItem({ name: 'Rice', state: 'some' });
  app.addPantryItem({ name: 'Milk', location: 'fridge', state: 'some' });
  app.setPantrySearch('mil');
  assert.match(el('pantryList').innerHTML, /Milk/);
  assert.doesNotMatch(el('pantryList').innerHTML, /Rice/);
  app.setPantrySearch('');
  assert.match(el('pantryList').innerHTML, /Rice/);
});
