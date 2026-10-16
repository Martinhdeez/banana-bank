import { seedApp } from '../src/seed';
import { appDb } from '../src/db';
import { config } from '../src/config';
import { seedBank } from '../simulator/seed';
import fs from 'node:fs';
import path from 'node:path';
import { backupAppDb } from './backup';
const marker = path.join(config.dataDir, 'app-running.pid');
if (fs.existsSync(marker)) {
  const pid = Number(fs.readFileSync(marker, 'utf8'));
  try {
    process.kill(pid, 0);
    console.error('Stop npm run dev/start before resetting the data.');
    process.exit(1);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') fs.rmSync(marker, { force: true });
    else throw e;
  }
}
// INT4: keep the local activity before wiping it; a failed backup throws and aborts the reset.
const backup = await backupAppDb();
if (backup) console.log(`Backup saved: ${backup}`);
// INT2: a database newer than this code is refused (and the refusal points here). The seed wipes
// every app table anyway, so reset replaces that file instead of failing on it.
try {
  appDb();
} catch (e) {
  if (!/schema version/.test(String(e))) throw e;
  for (const f of ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm'])
    fs.rmSync(path.join(config.dataDir, f), { force: true });
}
seedBank();
console.log(seedApp());
// TR1 (plan 27 D11): usage rows survive a reseed (seedApp) and are cleared only here; the backup
// above keeps them.
appDb().exec('DELETE FROM ai_usage');
console.log('Data, conversations, index, and scenarios restored.');
