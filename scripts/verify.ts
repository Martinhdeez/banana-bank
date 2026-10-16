// INT3: one gate command for builders and reviewers; offline-safe (audit steps skip without network).
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
type Lock = {
  lockfileVersion: number;
  packages: Record<
    string,
    Manifest & { integrity?: string; resolved?: string; link?: boolean; inBundle?: boolean }
  >;
};

export function checkLockfile(pkg: Manifest, lock: Lock): string | null {
  if (lock.lockfileVersion !== 3) return `lockfileVersion is ${lock.lockfileVersion}, expected 3`;
  const root = lock.packages[''] ?? {};
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const want = pkg[field] ?? {};
    const got = root[field] ?? {};
    if (isDeepStrictEqual(want, got)) continue;
    const name = [...new Set([...Object.keys(want), ...Object.keys(got)])].find(
      (n) => want[n] !== got[n],
    );
    return `${field}.${name}: package.json has ${want[name!] ?? 'nothing'}, package-lock.json has ${got[name!] ?? 'nothing'} (run npm install, then commit both)`;
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '' || entry.link || entry.inBundle) continue;
    if (!entry.integrity?.startsWith('sha512-')) return `${path}: missing sha512 integrity`;
    if (!entry.resolved?.startsWith('https://registry.npmjs.org/'))
      return `${path}: resolved outside the npm registry (${entry.resolved})`;
  }
  return null;
}

const shell = process.platform === 'win32';
const offline = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNRESET|network/i;
type Result = { step: string; status: 'ok' | 'FAIL' | 'skipped'; required: boolean; note?: string };

function run(step: string, args: string[]): Result {
  console.log(`\n> npm ${args.join(' ')}`);
  const { status } = spawnSync('npm', args, { stdio: 'inherit', shell });
  return { step, status: status === 0 ? 'ok' : 'FAIL', required: true };
}

function capture(args: string[]) {
  const r = spawnSync('npm', args, { encoding: 'utf8', shell });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function audit(): Result {
  const { out } = capture(['audit', '--json']);
  let v: Record<string, number> | undefined;
  try {
    v = JSON.parse(out).metadata?.vulnerabilities;
  } catch {}
  if (!v)
    return {
      step: 'audit',
      status: 'skipped',
      required: false,
      note: offline.test(out) ? 'offline' : out.trim().slice(0, 120),
    };
  const note = ['critical', 'high', 'moderate', 'low'].map((k) => `${k} ${v[k]}`).join(', ');
  return { step: 'audit', status: v.high + v.critical > 0 ? 'FAIL' : 'ok', required: false, note };
}

function signatures(): Result {
  const { status, out } = capture(['audit', 'signatures']);
  if (status !== 0 && offline.test(out))
    return { step: 'signatures', status: 'skipped', required: false, note: 'offline' };
  if (status !== 0) console.log(out);
  const note = out.match(/\d+ packages? have verified registry signatures/)?.[0];
  return { step: 'signatures', status: status === 0 ? 'ok' : 'FAIL', required: false, note };
}

function lockfile(): Result {
  const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const problem = checkLockfile(read('package.json'), read('package-lock.json'));
  if (problem) console.log(`lockfile: ${problem}`);
  return {
    step: 'lockfile',
    status: problem ? 'FAIL' : 'ok',
    required: true,
    note: problem ?? undefined,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = [lockfile()];
  const installed = run('installed', ['ls', '--all', '--silent']);
  if (installed.status === 'FAIL')
    installed.note = 'node_modules does not match the lockfile: run npm ci';
  results.push(
    installed,
    run('typecheck', ['run', 'typecheck']),
    run('format', ['run', 'format:check']),
    run('test', ['test']),
    audit(),
    signatures(),
  );
  console.log('\nverify summary');
  for (const r of results)
    console.log(
      `  ${r.step.padEnd(11)} ${r.status.padEnd(8)} ${r.required ? 'required' : 'advisory'}  ${r.note ?? ''}`,
    );
  // A high/critical advisory or an invalid signature fails the run; "advisory" only means offline is tolerated.
  process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
}
