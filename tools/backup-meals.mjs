#!/usr/bin/env node
// Weekly backup of the household's Meal Planner data onto this PC.
// Downloads the read-only export and every photo, proves the copy restores into an empty database,
// then keeps the newest 12 backups. Config: <backup dir>\backup-config.json {"url": "...", "token": "..."}.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCore } from '../api/_lib/core.js';
import { sqliteDatabase } from '../hub/server.mjs';

const KEEP = 12;
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

// Restores a backup folder into a throwaway database and checks every piece arrived.
export async function verifyBackup(folder) {
  const dump = JSON.parse(fs.readFileSync(path.join(folder, 'backup.json'), 'utf8'));
  const photos = {};
  for (const photo of dump.photos) photos[photo.id] = fs.readFileSync(path.join(folder, 'photos', `${photo.id}${EXT[photo.type] || '.bin'}`));
  const db = sqliteDatabase(':memory:');
  try {
    const core = createCore({ db });
    await core.importAll(dump, photos);
    const again = await core.exportAll();
    const same = again.records.length === dump.records.length && again.actions.length === dump.actions.length && again.photos.length === dump.photos.length && again.seq === dump.seq;
    if (!same) throw new Error('The restored copy does not match the backup.');
    return { records: dump.records.length, actions: dump.actions.length, photos: dump.photos.length };
  } finally { db.raw.close(); }
}

export async function runBackup({ dir, url, token, fetchImpl = fetch, now = new Date() }) {
  const headers = { Authorization: `Bearer ${token}` };
  const res = await fetchImpl(`${url.replace(/\/$/, '')}/api/export`, { headers });
  if (!res.ok) throw new Error(`Export failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const dump = await res.json();
  if (dump.format !== 'nexa-meal-backup/v1') throw new Error('The export is not a meal planner backup.');
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const folder = path.join(dir, stamp), partial = `${folder}.partial`;
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(path.join(partial, 'photos'), { recursive: true });
  for (const photo of dump.photos) {
    const photoRes = await fetchImpl(`${url.replace(/\/$/, '')}/api/export/photos/${encodeURIComponent(photo.id)}`, { headers });
    if (!photoRes.ok) throw new Error(`Photo ${photo.id} failed: ${photoRes.status}`);
    fs.writeFileSync(path.join(partial, 'photos', `${photo.id}${EXT[photo.type] || '.bin'}`), Buffer.from(await photoRes.arrayBuffer()));
  }
  fs.writeFileSync(path.join(partial, 'backup.json'), JSON.stringify(dump));
  const counts = await verifyBackup(partial);
  fs.renameSync(partial, folder);
  const backups = fs.readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/.test(name)).sort();
  backups.slice(0, Math.max(0, backups.length - KEEP)).forEach(name => fs.rmSync(path.join(dir, name), { recursive: true, force: true }));
  return { folder, ...counts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.env.MEALS_BACKUP_DIR || path.join(os.homedir(), 'NEXA-Data', 'meal-backups');
  fs.mkdirSync(dir, { recursive: true });
  const log = line => fs.appendFileSync(path.join(dir, 'backup.log'), `${new Date().toISOString()} ${line}\n`);
  const configFile = path.join(dir, 'backup-config.json');
  try {
    if (!fs.existsSync(configFile)) throw new Error(`Missing ${configFile} with {"url": "...", "token": "..."}`);
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const result = await runBackup({ dir, url: config.url, token: config.token });
    log(`OK ${path.basename(result.folder)}: ${result.records} records, ${result.actions} actions, ${result.photos} photos (restore verified)`);
    console.log(`Backup saved and verified: ${result.folder}`);
  } catch (error) {
    log(`FAILED ${error.message}`);
    console.error(`Backup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
