// Runs every tests/e2e/*.e2e.mjs one after another against an app that is already running
// (README "End-to-end checks"). The env passes through; each suite's output streams as it runs.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import readline from 'node:readline';
const suites = fs
  .readdirSync('tests/e2e')
  .filter((f) => f.endsWith('.e2e.mjs'))
  .sort();
const results = [];
for (const file of suites) {
  console.log(`\n=== ${file}`);
  const started = Date.now();
  // A SKIP line is a check (or a group of checks) the suite could not run on this bank. They are
  // counted, so a suite that passed with skips is not read as a full pass.
  let skips = 0;
  const child = spawn(process.execPath, [`tests/e2e/${file}`], {
    stdio: ['inherit', 'pipe', 'inherit'],
  });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (line.startsWith('SKIP ')) skips++;
    console.log(line);
  });
  const [status] = await once(child, 'close');
  const seconds = Math.round((Date.now() - started) / 1000);
  results.push({ file, ok: status === 0, skips, seconds });
}
console.log('');
for (const r of results)
  console.log(
    `${r.ok ? 'PASS' : 'FAIL'} ${r.file} (${r.seconds} s)${r.skips ? ` — ${r.skips} SKIP` : ''}`,
  );
const failed = results.filter((r) => !r.ok).length;
const skips = results.reduce((n, r) => n + r.skips, 0);
console.log(`${suites.length - failed}/${suites.length} suites passed`);
if (skips)
  console.log(
    `${skips} SKIP lines: those checks did not run on this bank (each line says why). ` +
      'The ones that need the demo bank run with `npm run e2e:demo`.',
  );
process.exit(failed ? 1 : 0);
