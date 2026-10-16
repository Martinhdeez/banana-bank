import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config';
let instance: Database.Database | undefined;
export function bankDb() {
  if (!instance) {
    fs.mkdirSync(config.bankDataDir, { recursive: true });
    instance = new Database(path.join(config.bankDataDir, 'bank.sqlite'));
    instance.pragma('journal_mode = WAL');
    instance.pragma('foreign_keys = ON');
    instance.pragma('busy_timeout = 5000');
    instance.exec(`
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,userId TEXT NOT NULL,label TEXT NOT NULL,iban TEXT NOT NULL,balanceCents INTEGER NOT NULL CHECK(balanceCents>=0));
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,userId TEXT NOT NULL,reference TEXT NOT NULL,fromAccountId TEXT NOT NULL,toAccountId TEXT NOT NULL,amountCents INTEGER NOT NULL,concept TEXT NOT NULL,createdAt TEXT NOT NULL,status TEXT NOT NULL,UNIQUE(userId,reference));
      CREATE TABLE IF NOT EXISTS movements(id TEXT PRIMARY KEY,accountId TEXT NOT NULL REFERENCES accounts(id),operationId TEXT,amountCents INTEGER NOT NULL,description TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scenario(id INTEGER PRIMARY KEY CHECK(id=1),profile TEXT NOT NULL,seed INTEGER NOT NULL,counter INTEGER NOT NULL,read_failures INTEGER NOT NULL);
      INSERT OR IGNORE INTO scenario VALUES(1,'intermittent',17,0,0);
    `);
  }
  return instance;
}
export function closeBankDb() {
  instance?.close();
  instance = undefined;
}
