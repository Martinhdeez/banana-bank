// IT3: the packager's secret scan (scripts/package-submission.sh --scan) runs inside `npm test`, so
// a key-shaped string in a tracked file fails `npm run verify` instead of the delivery build.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scan = (...files: string[]) =>
  spawnSync('bash', [path.join(root, 'scripts/package-submission.sh'), '--scan', ...files], {
    encoding: 'utf8',
  });
// The script needs bash; the tracked tree also needs Git, which an extracted ZIP does not have.
const noBash = process.platform === 'win32';
const skip =
  noBash || (!fs.existsSync(path.join(root, '.git')) && 'no Git here: the tracked tree is unknown');

test('IT3: no tracked file holds a key-shaped string (the packager would refuse)', { skip }, () => {
  const { status, stderr } = scan();
  assert.equal(status, 0, `build made-up keys at runtime from parts instead.\n${stderr}`);
});

test('IT3: the scan names file:line of a key-shaped string', { skip: noBash }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it3-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const planted = path.join(dir, 'planted.txt');
  fs.writeFileSync(planted, `clean\nkey = ${'sk-'}${'x'.repeat(24)}\n`);
  const clean = path.join(dir, 'clean.txt');
  fs.writeFileSync(clean, `${'sk-'}FAKE${'x'.repeat(24)} and sk-short\n`);

  const { status, stderr } = scan(planted, clean);
  assert.equal(status, 1);
  assert.match(stderr, /Refusing to package/);
  assert.ok(stderr.includes(`${planted}:2`), stderr);
  assert.ok(!stderr.includes(clean), stderr);
  assert.doesNotMatch(stderr, /x{24}/); // the report names the place, never the value
  assert.equal(scan(clean).status, 0);
});
