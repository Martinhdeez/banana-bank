// SI9: `npm run demo` starts the app against the independent bank (tests/alt-bank/server.ts)
// seeded with the demo movements, on its own ports and data directory: never .data, 3000 or 4001.
//
//   npm run demo [-- --production] [-- --fresh]
//   DEMO_DATA_DIR (.data-demo), DEMO_APP_PORT (3610), DEMO_BANK_PORT (4611)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const bankPort = process.env.DEMO_BANK_PORT || '4611';
Object.assign(process.env, {
  DATA_DIR: process.env.DEMO_DATA_DIR || '.data-demo',
  APP_PORT: process.env.DEMO_APP_PORT || '3610',
  BANK_PORT: bankPort,
  BANK_URL: `http://127.0.0.1:${bankPort}`,
  BANK_EXTERNAL: '1',
});
// IT7 (A10): `--fresh` forgets what a rehearsal left (rules, confirmed categories, conversations).
// The demo bank is in memory, so the app database is the whole state: only its three files are
// removed, and only in a demo directory inside the repository — never the repository itself,
// `.data` (the data of `npm run dev`) or a path outside.
if (process.argv.includes('--fresh')) {
  // The real path: a link inside the repository that points at `.data` or outside is refused too.
  const real = (p: string) => (fs.existsSync(p) ? fs.realpathSync(p) : p);
  const root = real(path.resolve(import.meta.dirname, '..'));
  const dir = real(path.resolve(process.env.DATA_DIR!));
  const inside = path.relative(root, dir);
  const refuse = (why: string) => {
    console.error(`--fresh refused: ${why} (DEMO_DATA_DIR resolves to ${dir}).`);
    process.exit(1);
  };
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside))
    refuse('the demo data directory must be a folder inside the repository');
  if (inside === '.data') refuse('.data is the data of `npm run dev`, not the demo');
  // The marker scripts/dev.ts writes: a database is not removed under a running app.
  const marker = path.join(dir, 'app-running.pid');
  let running = false;
  try {
    running = fs.existsSync(marker) && process.kill(Number(fs.readFileSync(marker, 'utf8')), 0);
  } catch {
    // No such process: the marker of a demo that was stopped.
  }
  if (running) refuse('an application is using this directory: stop it first');
  for (const file of ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm'])
    fs.rmSync(path.join(dir, file), { force: true });
  console.log(`Fresh demo data in ${dir}.`);
}
// Imported after the environment is set: src/config.ts reads it, and .env.local, at import time.
const { config } = await import('../src/config');
const { appDb, closeAppDb } = await import('../src/db');
const { seedApp } = await import('../src/seed');
// The setup step of `npm run setup` for this directory: seed the app database only when empty.
if (!appDb().prepare('SELECT value FROM meta WHERE key=?').get('seed')) console.log(seedApp());
closeAppDb();

// Which decider the app will use (contracts.md §5, `auto`): no key is needed, rules still run.
const has = (name: string) => !!process.env[name]?.trim();
const wanted = process.env.DECIDER?.trim() || 'auto';
const automatic = has('DECIDER_API_KEY') ? 'systemone' : has('OPENAI_API_KEY') ? 'openai' : 'none';
const decider =
  wanted === 'auto' ? automatic : wanted === 'openai' && !has('OPENAI_API_KEY') ? 'none' : wanted;
console.log(
  `Demo: http://127.0.0.1:${config.appPort} · bank ${config.bankUrl} · data ${config.dataDir} · decider: ${decider}`,
);

// The bank gets the app's service secret and no model key.
const { OPENAI_API_KEY, DECIDER_API_KEY, ...bankEnv } = process.env;
const node = (script: string, args: string[], env: NodeJS.ProcessEnv) =>
  spawn(process.execPath, ['--import', 'tsx', script, ...args], { stdio: 'inherit', env });
const children = [
  node('tests/alt-bank/server.ts', [], {
    ...bankEnv,
    ALT_BANK_PORT: bankPort,
    ALT_BANK_SEED_FILE: 'tests/alt-bank/demo-seed.json',
    ALT_BANK_MOVEMENTS_LIMIT: '100',
    BANK_SERVICE_SECRET: config.serviceSecret,
  }),
  // scripts/dev.ts waits for the bank's /health before it starts the web service.
  node('scripts/dev.ts', process.argv.slice(2), process.env),
];
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(
    children.map(
      (child) =>
        child.exitCode ?? child.signalCode ?? new Promise((done) => child.once('exit', done)),
    ),
  );
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop());
for (const child of children) child.on('exit', (code) => stop(code || 1));
