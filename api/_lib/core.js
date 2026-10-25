// Household sync core, shared by the Vercel functions (Postgres on Neon) and the PC hub (SQLite).
// SQL is written once with $1-style placeholders; each adapter runs it on its own database.
// Adapter: { query(sql, params) -> rows, transaction(fn(tx)) -> result, blobType }.
import crypto from 'node:crypto';

export const RECORD_TYPES = ['pantry', 'recipe', 'plan', 'checked', 'history', 'picks', 'feedback', 'prefs', 'planUndo'];
export const PHOTO_TYPES = { 'image/jpeg': true, 'image/png': true, 'image/webp': true };
export const PHOTO_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const MAX_JSON = 2 * 1024 * 1024;
export const MAX_PHOTO = 4 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_:-]{1,60}$/;
const MAX_ITEMS = 3000;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function schema(blobType) {
  return [
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    `CREATE TABLE IF NOT EXISTS records (
      type TEXT NOT NULL, id TEXT NOT NULL, data TEXT, deleted INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, seq INTEGER NOT NULL,
      PRIMARY KEY (type, id))`,
    'CREATE INDEX IF NOT EXISTS records_seq ON records (seq)',
    `CREATE TABLE IF NOT EXISTS actions (
      id TEXT PRIMARY KEY, key TEXT NOT NULL, data TEXT NOT NULL, undone_at TEXT,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, seq INTEGER NOT NULL)`,
    // One live action per key: two phones can't both log "cooked Wednesday".
    'CREATE UNIQUE INDEX IF NOT EXISTS actions_active_key ON actions (key) WHERE undone_at IS NULL',
    'CREATE INDEX IF NOT EXISTS actions_seq ON actions (seq)',
    `CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, type TEXT NOT NULL, data ${blobType} NOT NULL, updated_at TEXT NOT NULL)`,
    'CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start TEXT NOT NULL)',
  ];
}

export function createCore({ db, nameOf = key => key, now = () => new Date() }) {
  let ready = null;
  function ensure() {
    ready ??= (async () => {
      for (const statement of schema(db.blobType)) await db.query(statement, []);
      await db.query("INSERT INTO meta (key, value) VALUES ('household', $1) ON CONFLICT (key) DO NOTHING", [crypto.randomUUID()]);
      await db.query("INSERT INTO meta (key, value) VALUES ('seq', '0') ON CONFLICT (key) DO NOTHING", []);
    })().catch(error => { ready = null; throw error; });
    return ready;
  }

  const recordOut = row => ({ type: row.type, id: row.id, data: Number(row.deleted) ? null : JSON.parse(row.data), deleted: !!Number(row.deleted),
    version: Number(row.version), updatedAt: row.updated_at, updatedBy: nameOf(row.updated_by) });
  const actionOut = row => ({ ...JSON.parse(row.data), id: row.id, key: row.key, undoneAt: row.undone_at, createdBy: nameOf(row.created_by) });

  function validateSync(input) {
    if (!input || typeof input !== 'object') throw new HttpError(400, 'Expected a JSON object.');
    const cursor = Number(input.cursor ?? 0);
    if (!Number.isInteger(cursor) || cursor < 0) throw new HttpError(400, 'cursor must be a whole number.');
    const records = input.records ?? [], actions = input.actions ?? [];
    if (!Array.isArray(records) || !Array.isArray(actions) || records.length > MAX_ITEMS || actions.length > MAX_ITEMS) throw new HttpError(400, 'records and actions must be lists.');
    for (const record of records) {
      if (!RECORD_TYPES.includes(record?.type) || typeof record.id !== 'string' || !ID_RE.test(record.id)) throw new HttpError(400, 'A record has an unknown type or a bad id.');
    }
    for (const action of actions) {
      if (typeof action?.id !== 'string' || !ID_RE.test(action.id) || typeof action.key !== 'string' || !action.key || action.key.length > 2000 || !action.data || typeof action.data !== 'object') {
        throw new HttpError(400, 'An action is malformed.');
      }
    }
    return { cursor, records, actions };
  }

  // Push then pull in one transaction. Records: the later write wins, and the writer hears whose change it replaced.
  // Actions: a second live action with the same key is refused, along with the pantry records it touched.
  async function sync(member, input) {
    const { cursor, records, actions } = validateSync(input);
    await ensure();
    const stamp = now().toISOString();
    const applied = [], replaced = [], rejectedActions = [], skipped = [];
    const written = new Set(), writtenActions = new Set(), skipKeys = new Set();
    let seq;
    await db.transaction(async tx => {
      const one = async (sql, params) => (await tx.query(sql, params))[0];
      // Taking the counter row first serialises syncs, so sequence numbers never interleave.
      seq = Number((await one("UPDATE meta SET value = value WHERE key = 'seq' RETURNING value", [])).value);
      for (const action of actions) {
        const existing = await one('SELECT * FROM actions WHERE id = $1', [action.id]);
        const undoneAt = typeof action.undoneAt === 'string' ? action.undoneAt : null;
        if (existing) {
          if (undoneAt && !existing.undone_at) { await tx.query('UPDATE actions SET undone_at = $1, seq = $2 WHERE id = $3', [undoneAt, ++seq, action.id]); writtenActions.add(action.id); }
          continue;
        }
        if (!undoneAt) {
          const duplicate = await one('SELECT * FROM actions WHERE key = $1 AND undone_at IS NULL', [action.key]);
          if (duplicate) {
            rejectedActions.push({ id: action.id, key: action.key, existingId: duplicate.id, by: nameOf(duplicate.created_by), at: duplicate.created_at, label: String(action.data.label || '') });
            (Array.isArray(action.touches) ? action.touches : []).forEach(id => { if (typeof id === 'string' && ID_RE.test(id)) skipKeys.add(`pantry\u0000${id}`); });
            continue;
          }
        }
        await tx.query('INSERT INTO actions (id, key, data, undone_at, created_by, created_at, seq) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [action.id, action.key, JSON.stringify(action.data), undoneAt, member.key, stamp, ++seq]);
        writtenActions.add(action.id);
      }
      for (const record of records) {
        const key = `${record.type}\u0000${record.id}`;
        if (skipKeys.has(key)) { skipped.push(key); continue; }
        const current = await one('SELECT * FROM records WHERE type = $1 AND id = $2', [record.type, record.id]);
        const deleted = record.deleted === true;
        const data = deleted ? null : JSON.stringify(record.data ?? null);
        if (data && data.length > MAX_JSON) throw new HttpError(413, 'A record is too large.');
        if (!current) {
          await tx.query('INSERT INTO records (type, id, data, deleted, version, updated_at, updated_by, seq) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [record.type, record.id, data, deleted ? 1 : 0, 1, stamp, member.key, ++seq]);
          applied.push({ type: record.type, id: record.id, version: 1 });
        } else {
          const version = Number(current.version);
          if (version !== Number(record.baseVersion) && current.updated_by !== member.key) {
            replaced.push({ type: record.type, id: record.id, by: nameOf(current.updated_by), at: current.updated_at,
              previous: Number(current.deleted) ? null : JSON.parse(current.data), previousDeleted: !!Number(current.deleted) });
          }
          await tx.query('UPDATE records SET data = $1, deleted = $2, version = $3, updated_at = $4, updated_by = $5, seq = $6 WHERE type = $7 AND id = $8',
            [data, deleted ? 1 : 0, version + 1, stamp, member.key, ++seq, record.type, record.id]);
          applied.push({ type: record.type, id: record.id, version: version + 1 });
        }
        written.add(key);
      }
      await tx.query("UPDATE meta SET value = $1 WHERE key = 'seq'", [String(seq)]);
    });
    const changedRecords = (await db.query('SELECT * FROM records WHERE seq > $1 ORDER BY seq', [cursor]))
      .filter(row => !written.has(`${row.type}\u0000${row.id}`)).map(recordOut);
    // Records held back with a refused action come back as the hub has them, so the phone drops its version.
    for (const key of skipped) {
      if (changedRecords.some(record => `${record.type}\u0000${record.id}` === key)) continue;
      const [type, id] = key.split('\u0000');
      const [row] = await db.query('SELECT * FROM records WHERE type = $1 AND id = $2', [type, id]);
      changedRecords.push(row ? recordOut(row) : { type, id, data: null, deleted: true, version: 0, updatedAt: stamp, updatedBy: '' });
    }
    const changedActions = (await db.query('SELECT * FROM actions WHERE seq > $1 ORDER BY seq', [cursor]))
      .filter(row => !writtenActions.has(row.id)).map(actionOut);
    return { cursor: seq, applied, replaced, rejectedActions, skipped: skipped.map(key => key.replace('\u0000', ':')), changes: { records: changedRecords, actions: changedActions } };
  }

  return {
    ensure,
    sync,
    async household() { await ensure(); return (await db.query("SELECT value FROM meta WHERE key = 'household'", []))[0].value; },
    async getPhoto(id) {
      await ensure();
      const [row] = await db.query('SELECT type, data FROM photos WHERE id = $1', [id]);
      return row ? { type: row.type, data: Buffer.from(row.data) } : null;
    },
    async putPhoto(id, type, data) {
      await ensure();
      await db.query('INSERT INTO photos (id, type, data, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET type = excluded.type, data = excluded.data, updated_at = excluded.updated_at',
        [id, type, data, now().toISOString()]);
    },
    async deletePhoto(id) { await ensure(); await db.query('DELETE FROM photos WHERE id = $1', [id]); },
    // Failed passcode attempts per key (an IP), counted in a fixed window.
    async loginAllowed(key, { limit = 10, windowMs = 15 * 60_000 } = {}) {
      await ensure();
      const [row] = await db.query('SELECT count, window_start FROM login_attempts WHERE key = $1', [key]);
      return !row || now() - new Date(row.window_start) > windowMs || Number(row.count) < limit;
    },
    async loginFailed(key, { windowMs = 15 * 60_000 } = {}) {
      await ensure();
      const stamp = now();
      const [row] = await db.query('SELECT count, window_start FROM login_attempts WHERE key = $1', [key]);
      if (!row || stamp - new Date(row.window_start) > windowMs) {
        await db.query('INSERT INTO login_attempts (key, count, window_start) VALUES ($1, 1, $2) ON CONFLICT (key) DO UPDATE SET count = 1, window_start = excluded.window_start', [key, stamp.toISOString()]);
      } else {
        await db.query('UPDATE login_attempts SET count = count + 1 WHERE key = $1', [key]);
      }
    },
    async loginSucceeded(key) { await ensure(); await db.query('DELETE FROM login_attempts WHERE key = $1', [key]); },
  };
}
