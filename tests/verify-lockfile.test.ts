import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkLockfile } from '../scripts/verify';

// INT3: `npm run verify` checks that package.json and package-lock.json agree and every package is pinned by hash to the registry.
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const copy = () => structuredClone(lock);

test('INT3 the repository lockfile passes', () => {
  assert.equal(checkLockfile(pkg, lock), null);
});

test('INT3 a range drift is reported', () => {
  const drifted = { ...pkg, devDependencies: { ...pkg.devDependencies, typescript: '^5.9.3' } };
  assert.match(checkLockfile(drifted, lock) ?? '', /typescript/);
});

test('INT3 a package without integrity is reported', () => {
  const l = copy();
  delete l.packages['node_modules/zod'].integrity;
  assert.match(checkLockfile(pkg, l) ?? '', /node_modules\/zod/);
});

test('INT3 a non-registry resolved URL is reported', () => {
  const l = copy();
  l.packages['node_modules/zod'].resolved = 'git+https://github.com/colinhacks/zod.git';
  assert.match(checkLockfile(pkg, l) ?? '', /node_modules\/zod/);
});
