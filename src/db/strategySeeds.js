import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateStrategyConfig } from '../strategy/schema.js';
import { logger } from '../log.js';

const log = logger('strategies');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.resolve(__dirname, '../../strategies');

export function loadStrategiesFromDisk(dir = DEFAULT_DIR) {
  if (!fs.existsSync(dir)) {
    throw new Error(`strategies directory not found: ${dir}`);
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  if (!files.length) throw new Error(`no strategy JSON files in ${dir}`);

  const strategies = [];
  let enabledCount = 0;
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stem = file.replace(/\.json$/, '');
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch (err) {
      throw new Error(`${file}: invalid JSON — ${err.message}`);
    }
    if (!raw.id || !raw.name || !raw.config) {
      throw new Error(`${file}: missing required top-level fields (id, name, config)`);
    }
    if (raw.id !== stem) {
      throw new Error(`${file}: id "${raw.id}" must match filename stem "${stem}"`);
    }
    validateStrategyConfig(raw.config, raw.id);

    const enabled = Boolean(raw.enabled);
    if (enabled) enabledCount += 1;

    strategies.push({
      id: raw.id,
      name: raw.name,
      enabled,
      config: raw.config,
    });
  }

  if (enabledCount > 1) {
    const enabledIds = strategies.filter(s => s.enabled).map(s => s.id);
    throw new Error(`exactly one strategy may have enabled: true; found: ${enabledIds.join(', ')}`);
  }

  return strategies;
}

export function syncStrategiesToDb(db, strategies, { invalidateCache } = {}) {
  const ids = new Set(strategies.map(s => s.id));
  const ts = Date.now();
  const upsert = db.prepare(`
    INSERT INTO strategies (id, name, enabled, config_json, created_at_ms)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      enabled = excluded.enabled,
      config_json = excluded.config_json
  `);
  const stmt = db.transaction(() => {
    for (const s of strategies) {
      upsert.run(s.id, s.name, s.enabled ? 1 : 0, JSON.stringify(s.config), ts);
    }
    const existing = db.prepare('SELECT id FROM strategies').all().map(r => r.id);
    for (const id of existing) {
      if (!ids.has(id)) db.prepare('DELETE FROM strategies WHERE id = ?').run(id);
    }
  });
  stmt();
  if (typeof invalidateCache === 'function') invalidateCache();
  if (!strategies.some(s => s.enabled)) {
    const ids = strategies.map(s => s.id).join(', ');
    log.warn([
      '⚠️  No strategy has enabled: true in strategies/*.json.',
      `   Available: ${ids}`,
      '   Trading will fall back to the "sniper" config silently.',
      '   To activate one:',
      '     1. set "enabled": true in strategies/<id>.json',
      '     2. node scripts/cmd.js resetstrategies confirm   (or restart)',
    ].join('\n'));
  }
}

export function diffStrategies(fromDb, fromDisk) {
  const dbById = new Map(fromDb.map(s => [s.id, s]));
  const diskById = new Map(fromDisk.map(s => [s.id, s]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const s of fromDisk) {
    const prev = dbById.get(s.id);
    if (!prev) { added.push(s.id); continue; }
    const fields = [];
    if (Boolean(prev.enabled) !== Boolean(s.enabled)) fields.push(`enabled: ${Boolean(prev.enabled)} → ${Boolean(s.enabled)}`);
    for (const key of Object.keys(s.config)) {
      if (prev[key] !== s.config[key]) fields.push(`${key}: ${prev[key]} → ${s.config[key]}`);
    }
    if (fields.length) changed.push({ id: s.id, fields });
  }
  for (const s of fromDb) {
    if (!diskById.has(s.id)) removed.push(s.id);
  }
  return { added, removed, changed };
}
