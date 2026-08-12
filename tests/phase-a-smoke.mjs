import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const requiredMarkers = [
  'data-testid="tab-home"', 'id="panel-home"', 'data-testid="tab-pantry"',
  'data-testid="tab-shopping"', 'data-testid="tab-recipes"', 'Plan with NEXA',
  'Ready to paste into NEXA', 'fmp_feedback', 'Meal feedback (local only)',
  'Wednesday-to-Tuesday', 'id="wallToggle"',
  'id="genBtn" onclick="openPlanningPacket()"', 'function readJSON(key,fallback)',
  'function escapeHTML(value)', 'No accepted or saved plans yet.',
  'Accept or save a plan with NEXA to build your shopping list.',
  'Accept or save a plan with NEXA to see recipes.',
  'Accept or save a plan with NEXA to use Wall Mode.',
];
for (const marker of requiredMarkers) assert.ok(html.includes(marker), `Missing Phase A marker: ${marker}`);

assert.ok(!/https?:\/\//i.test(html), 'Phase A index.html must not contain an http(s) URL or external stylesheet');
assert.ok(!/<link\b[^>]*\brel=["']stylesheet["']/i.test(html), 'Phase A must not load an external stylesheet');

const forbiddenMarkers = [
  'fetch(', '/api/nexa/chat', '/api/ai/chat', 'SYNC_URL', 'Railway', 'railway',
  'nexa-finance', 'apiKey', 'fmp_key', 'nexa_key', 'keyModal', 'showKeyModal',
  'saveKey', 'clearKey', 'generatePlan', 'swapMeal', 'regenerateGroceryList',
  'fitness', 'Fitness', 'NEXAFIT', 'Quick Swap', 'quickSwap', 'syncToCloud',
  'loadFromCloud', '☁ Save', '⬇ Sync',
];
for (const marker of forbiddenMarkers) assert.ok(!html.includes(marker), `Prohibited Phase A marker remains: ${marker}`);

const initBody = html.match(/function init\(\)\{([\s\S]*?)\n\}/)?.[1] || '';
assert.ok(!initBody.includes('showKeyModal'), 'init must not auto-open an API-key modal');
assert.ok(!/\bonclick\s*=\s*["'][^"']*(?:sync|save)[^"']*["']/i.test(html), 'No cloud Save/Sync controls may remain');

const escapeSource = html.match(/function escapeHTML\(value\)\{[\s\S]*?\n\}/)?.[0];
assert.ok(escapeSource, 'escapeHTML helper must be defined');
const escapeSandbox = {};
vm.runInNewContext(`${escapeSource}; this.escapeHTML = escapeHTML;`, escapeSandbox);
assert.equal(escapeSandbox.escapeHTML('<img src=x onerror="bad"> & \'quoted\''), '&lt;img src=x onerror=&quot;bad&quot;&gt; &amp; &#39;quoted&#39;');

const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'inline application script must be present');
const applicationScript = script.replace(/\ninit\(\);\nif\(mealPlan\) renderPlanReady\(\);\s*$/, '').concat(`
this.setMealPlanForTest = value => { mealPlan = value; };
this.setFeedbackForTest = value => { mealFeedback = value; };
this.getStateForTest = () => ({pantryState, pantryQty, checkedItems, exclusions, otherExcl, cuisineStyle, weeklyBudget, servings, mealHistory, mealFeedback});
this.renderAll = () => { groceryProgress(); renderHome(); renderPlanReady(); renderShopping(); renderRecipes(); renderWallStrip(); renderWallRecipe(); renderWallSide(); renderHistoryPanel(); };
this.buildPacketForTest = buildPlanningPacket;`);

const expectedInitIds = [
  'proteinsGrid', 'vegetablesGrid', 'spicesGrid', 'exclusionChips', 'cuisineChips',
  'monthName', 'budgetSlider', 'budgetDisplay', 'srvDisplay', 'srvMinus', 'srvPlus',
  'seasonalToggle', 'workPackToggle', 'otherExclusion', 'workPackNote', 'shoppingContent',
  'recipesContent', 'homeContent', 'historyCount', 'planReadyCard', 'planReadyMeta',
  'wallWeekStrip', 'wallRecipe', 'wallSide', 'historyList',
];
const sourceIds = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]));
for (const id of expectedInitIds) assert.ok(sourceIds.has(id), `Required init node missing from app HTML: #${id}`);

function createSandbox(storage = {}) {
  const elements = new Map([...sourceIds].map(id => [id, {
    id, innerHTML: '', textContent: '', value: '', checked: false,
    style: {}, disabled: false, classList: { add() {}, remove() {}, toggle() {} },
    focus() {}, select() {}, scrollIntoView() {},
  }]));
  const document = {
    getElementById(id) {
      const node = elements.get(id);
      if (!node) throw new Error(`Unexpected/missing app node requested: #${id}`);
      return node;
    },
    querySelectorAll() { return []; },
  };
  const localStorage = {
    getItem: key => Object.hasOwn(storage, key) ? storage[key] : null,
    setItem: (key, value) => { storage[key] = String(value); },
    removeItem: key => { delete storage[key]; },
  };
  const sandbox = { document, localStorage, navigator: {}, setTimeout: () => 0, clearInterval: () => {}, setInterval: () => 0 };
  vm.runInNewContext(applicationScript, sandbox);
  return sandbox;
}

const malformedStorage = {
  fmp_excl: '{}',
  fmp_pantry: '[]',
  fmp_pantry_qty: '{"chicken":7,"bad":null,"nested":{"x":1}}',
  fmp_checked: '[]',
  fmp_feedback: '{"meal":null,"wrong":"bad"}',
  fmp_budget: 'abc',
  fmp_servings: '99',
  fmp_other: '{not-a-preference}',
  fmp_cuisine: '{not-a-preference}',
  fmp_history: '[null,{"date":null},"bad"]',
  fmp_plan: '{"weeklyMealPlan":[null],"groceryList":{"produce":[null]}}',
};
const malformedSandbox = createSandbox(malformedStorage);
assert.doesNotThrow(() => malformedSandbox.init(), 'init/render must tolerate malformed persisted local state');
const normalized = malformedSandbox.getStateForTest();
assert.equal(JSON.stringify(normalized.exclusions), '[]', 'fmp_excl must normalize to []');
assert.equal(JSON.stringify(normalized.pantryQty), '{"chicken":"7"}', 'fmp_pantry_qty must retain only safe string values');
assert.equal(JSON.stringify(normalized.checkedItems), '{}', 'fmp_checked must normalize to {}');
assert.equal(normalized.weeklyBudget, 90, 'invalid budget must default to 90');
assert.equal(normalized.servings, 2, 'invalid servings must default to 2');
assert.equal(JSON.stringify(normalized.mealHistory), '[{"date":null}]', 'history must retain records only');
assert.equal(JSON.stringify(normalized.mealFeedback), '{"meal":{"rating":"","note":""},"wrong":{"rating":"","note":""}}', 'feedback must normalize malformed values safely');
assert.doesNotThrow(() => malformedSandbox.buildPacketForTest(), 'packet builder must tolerate normalized malformed feedback/preferences');

const sandbox = createSandbox();
for (const malformedPlan of [
  { weeklyMealPlan: [null] },
  { weeklyMealPlan: [{}], groceryList: { produce: [null] } },
  { weeklyMealPlan: [{}], babyNewFoods: 'bad' },
  { weeklyMealPlan: [{}], workDayPacks: 'bad' },
]) {
  sandbox.setMealPlanForTest(malformedPlan);
  assert.doesNotThrow(() => sandbox.renderAll(), `rendering must tolerate ${JSON.stringify(malformedPlan)}`);
}
sandbox.setFeedbackForTest({ bad: null, odd: 'wrong' });
assert.doesNotThrow(() => sandbox.buildPacketForTest(), 'packet builder must not throw on malformed in-memory feedback');

console.log('Phase A smoke test passed.');
