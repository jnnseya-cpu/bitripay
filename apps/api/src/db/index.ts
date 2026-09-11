import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

export type Db = Database.Database;

let db: Db | null = null;

function loadMigrations(): { name: string; sql: string }[] {
  const dir = path.join(__dirname, 'migrations');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

export function migrate(database: Db) {
  database.exec(`CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)`);
  const applied = new Set(database.prepare('SELECT name FROM migrations').all().map((r: any) => r.name as string));
  for (const m of loadMigrations()) {
    if (applied.has(m.name)) continue;
    database.transaction(() => {
      database.exec(m.sql);
      database.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(m.name, new Date().toISOString());
    })();
  }
}

export function openDatabase(filePath = config.databasePath): Db {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const database = new Database(filePath);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  migrate(database);
  return database;
}

export function getDb(): Db {
  if (!db) db = openDatabase();
  return db;
}

/** Replace the active database (used by tests). */
export function setDb(database: Db) {
  db = database;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
