// A cleared Transfers form (after "Review transfer") must not show its empty fields as invalid.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('the invalid border of the amount and description skips empty fields', () => {
  const css = readFileSync(new URL('../app/styles/transfers.css', import.meta.url), 'utf8');
  const all = css.match(/:user-invalid/g) ?? [];
  const guarded = css.match(/:user-invalid:not\(:placeholder-shown\)/g) ?? [];
  assert.ok(all.length > 0);
  assert.equal(guarded.length, all.length);
});
