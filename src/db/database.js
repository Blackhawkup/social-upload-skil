import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { timeout: 5000 });
  db.pragma('busy_timeout = 5000');
  const currentJournalMode = String(db.pragma('journal_mode', { simple: true }) || '').toLowerCase();
  if (currentJournalMode !== 'wal') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');

  const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  ensureTempCloudObjectColumns(db);
  return db;
}

function ensureTempCloudObjectColumns(db) {
  const existingCols = new Set(
    db
      .prepare('PRAGMA table_info(temp_cloud_objects)')
      .all()
      .map((col) => col.name)
  );
  const migrations = [
    ['file_size_bytes', 'INTEGER NOT NULL DEFAULT 0'],
    ['multipart_upload_id', 'TEXT'],
    ['upload_phase', "TEXT NOT NULL DEFAULT 'completed'"],
    ['cleanup_attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_cleanup_attempt_at', 'TEXT'],
    ['aborted_at', 'TEXT'],
  ];
  for (const [colName, colDef] of migrations) {
    if (!existingCols.has(colName)) {
      db.exec(`ALTER TABLE temp_cloud_objects ADD COLUMN ${colName} ${colDef}`);
    }
  }
}
