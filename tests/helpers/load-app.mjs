import fs from 'node:fs';
import vm from 'node:vm';

export const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error('inline application script must be present');

// Drop the boot lines so each test controls init(), then expose module-level state.
const appScript = script.replace(/\ninit\(\);\nif\(mealPlan\) renderPlanReady\(\);\s*$/, '').concat(`
this.__state = () => ({ pantryItems, mealPlan, checkedItems, mealHistory, pendingProposal, acceptUndo, mealTypes, actions, putAwayDraft, cookDraft, ateDraft });
this.__set = (key, value) => { if (key === 'exclusions') exclusions = value; if (key === 'otherExcl') otherExcl = value; };`);

const sourceIds = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]));

export function createApp(storage = {}) {
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
  const app = {
    document, localStorage, navigator: {},
    setTimeout: () => 0, clearTimeout: () => {}, clearInterval: () => {}, setInterval: () => 0,
  };
  vm.runInNewContext(appScript, app);
  return { app, storage, el: id => document.getElementById(id) };
}
