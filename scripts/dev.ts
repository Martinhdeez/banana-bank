import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config';
import { usesBundledBank } from './bank-mode';
const production = process.argv.includes('--production');
fs.mkdirSync(config.dataDir, { recursive: true });
const marker = path.join(config.dataDir, 'app-running.pid');
if (fs.existsSync(marker)) {
  const pid = Number(fs.readFileSync(marker, 'utf8'));
  try {
    process.kill(pid, 0);
    throw new Error('An application is already using this data directory.');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
  }
}
fs.writeFileSync(marker, String(process.pid));
const bankEnv = { ...process.env };
delete bankEnv.OPENAI_API_KEY;
const bundled = usesBundledBank();
if (!bundled) console.log(`Using the external bank at ${config.bankUrl} (simulator not started).`);
const bank = bundled
  ? spawn(process.execPath, ['--import', 'tsx', 'simulator/server.ts'], {
      stdio: 'inherit',
      env: bankEnv,
    })
  : undefined;
let web: ReturnType<typeof spawn> | undefined,
  stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  const children = [web, bank].filter((p): p is ReturnType<typeof spawn> => !!p);
  for (const child of children) child.kill('SIGTERM');
  await Promise.race([
    Promise.all(
      children.map((child) =>
        child.exitCode !== null ? Promise.resolve() : new Promise((r) => child.once('exit', r)),
      ),
    ),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  fs.rmSync(marker, { force: true });
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop());
bank?.on('exit', (code) => {
  if (!stopping) stop(code || 1);
});
let ready = false;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${config.bankUrl}/health`, { signal: AbortSignal.timeout(500) });
    if (r.ok) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
}
if (!ready) {
  console.error(
    bundled
      ? 'The bank could not be started.'
      : `The external bank at ${config.bankUrl} is not reachable (GET /health).`,
  );
  stop(1);
} else {
  web = spawn(
    process.execPath,
    [
      'node_modules/next/dist/bin/next',
      production ? 'start' : 'dev',
      ...(!production ? ['--webpack'] : []),
      '-H',
      '127.0.0.1',
      '-p',
      String(config.appPort),
    ],
    { stdio: 'inherit', env: process.env },
  );
  web.on('exit', (code) => {
    if (!stopping) stop(code || 0);
  });
}
