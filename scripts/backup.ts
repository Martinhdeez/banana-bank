// INT4: consistent copy of the app database into <DATA_DIR>/backups/ with SQLite's online backup
// API, safe while the app runs (WAL included). The bank's database is not the app's to copy.
// ponytail: no rotation; prune by hand, add keep-last-N if backups pile up.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config';
import { verifyAuditChain } from '../src/audit';

// Own connection without migrations, so a database from newer code (INT2) is copied as it is.
export async function backupAppDb(): Promise<string | null> {
  const source = path.join(config.dataDir, 'app.sqlite');
  if (!fs.existsSync(source)) return null;
  const file = path.join(
    config.dataDir,
    'backups',
    `app-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(source, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    await db.backup(file);
  } finally {
    db.close();
  }
  // One self-contained file: a WAL-mode copy grows -wal/-shm siblings whenever it is opened.
  const copy = new Database(file);
  copy.pragma('journal_mode = DELETE');
  copy.close();
  return file;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = await backupAppDb();
  if (!file) console.log(`Nothing to back up: no app.sqlite in ${config.dataDir}.`);
  else {
    const copy = new Database(file, { readonly: true });
    const count = (sql: string) => (copy.prepare(sql).get() as { n: number }).n;
    console.log({
      file,
      schemaVersion: count('SELECT MAX(version) n FROM schema_migrations'),
      events: count('SELECT COUNT(*) n FROM events'),
      audit: verifyAuditChain(copy),
    });
    copy.close();
  }
}
