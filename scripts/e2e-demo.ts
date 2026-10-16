// `npm run e2e:demo`: the browser checks that need the demo bank (plan 23 contracts.md §7), with
// nothing skipped. Starts `npm run demo -- --production` with DECIDER=none on its own ports and a
// fresh data directory, runs the acceptance suite of the insights UI (or the suites given as
// arguments, each on fresh data), and stops what it started. No model is called.
//
//   npm run build && npm run e2e:demo [-- <name>.e2e.mjs …]
//   E2E_DEMO_APP_PORT (3920), E2E_DEMO_BANK_PORT (4921); PLAYWRIGHT_* and SHOTS as for `npm run e2e`.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const appPort = process.env.E2E_DEMO_APP_PORT || '3920';
const bankPort = process.env.E2E_DEMO_BANK_PORT || '4921';
const APP_URL = `http://127.0.0.1:${appPort}`;
const suites = process.argv.slice(2);
if (!suites.length) suites.push('acceptance-si7-insights-ui.e2e.mjs');
const healthy = () =>
  fetch(`${APP_URL}/api/health`).then(
    (r) => r.ok,
    () => false,
  );
// Another app on the port would be tested instead of the demo, on its own data.
if (await healthy()) {
  console.log(`FAIL env — something already answers on ${APP_URL}; set E2E_DEMO_APP_PORT`);
  process.exit(1);
}
let failed = 0;
for (const suite of suites) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bananabank-e2e-demo-'));
  const env = {
    ...process.env,
    DECIDER: 'none',
    DEMO_APP_PORT: appPort,
    DEMO_BANK_PORT: bankPort,
    DEMO_DATA_DIR: dataDir,
    APP_URL,
    BANK_URL: `http://127.0.0.1:${bankPort}`,
    DATA_DIR: dataDir,
  };
  // The server's access log would bury the checks: only its errors are shown.
  const demo = spawn(process.execPath, ['--import', 'tsx', 'scripts/demo.ts', '--production'], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env,
  });
  const gone = once(demo, 'exit');
  let up = false;
  for (let i = 0; i < 90 && !up && demo.exitCode === null; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    up = await healthy();
  }
  console.log(`\n=== ${suite} (demo bank, fresh data)`);
  if (up) {
    const run = spawnSync(process.execPath, [`tests/e2e/${suite}`], { stdio: 'inherit', env });
    if (run.status !== 0) failed++;
  } else {
    console.log('FAIL env — the demo app did not start (run `npm run build` first)');
    failed++;
  }
  // scripts/demo.ts stops its own children on SIGTERM.
  demo.kill('SIGTERM');
  await gone;
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(`\n${suites.length - failed}/${suites.length} suites passed on the demo bank`);
process.exit(failed ? 1 : 0);
