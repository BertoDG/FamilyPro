import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/** Abre la base de datos SQLite (fichero o ':memory:'). */
export function openDb(file = process.env.DB_FILE || 'data/familypro.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    scope TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (scope, version))`);
  return db;
}

/**
 * Aplica migraciones ordenadas para un ámbito (core o id de módulo).
 * Cada migración es un string SQL o una función (db) => void. Nunca se reordenan: solo se añaden al final.
 */
export function migrate(db, scope, migrations = []) {
  const row = db.prepare('SELECT MAX(version) AS v FROM _migrations WHERE scope = ?').get(scope);
  const current = row?.v ?? 0;
  migrations.forEach((m, i) => {
    const version = i + 1;
    if (version <= current) return;
    transaction(db, () => {
      typeof m === 'function' ? m(db) : db.exec(m);
      db.prepare('INSERT INTO _migrations (scope, version) VALUES (?, ?)').run(scope, version);
    });
  });
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
