import test from 'node:test';
import assert from 'node:assert/strict';
import { usesBundledBank } from '../scripts/bank-mode';

// DV1 (ALT-2): npm run dev / npm start spawn the simulator only when BANK_URL is the local BANK_PORT.
test('bundled bank by default and when BANK_URL is the local BANK_PORT', () => {
  assert.equal(usesBundledBank({}), true);
  assert.equal(usesBundledBank({ BANK_URL: 'http://127.0.0.1:4641', BANK_PORT: '4641' }), true);
  assert.equal(usesBundledBank({ BANK_URL: 'http://localhost:4001/' }), true);
});

test('external bank when BANK_EXTERNAL=1, even on the local port', () => {
  assert.equal(usesBundledBank({ BANK_EXTERNAL: '1' }), false);
  assert.equal(
    usesBundledBank({ BANK_EXTERNAL: '1', BANK_URL: 'http://127.0.0.1:4641', BANK_PORT: '4641' }),
    false,
  );
});

test('external bank when BANK_URL is another port or host', () => {
  assert.equal(usesBundledBank({ BANK_URL: 'http://127.0.0.1:4611', BANK_PORT: '4612' }), false);
  assert.equal(usesBundledBank({ BANK_URL: 'http://127.0.0.1:4611' }), false);
  assert.equal(usesBundledBank({ BANK_URL: 'https://bank.example.test' }), false);
  assert.equal(usesBundledBank({ BANK_URL: 'http://10.0.0.5:4001' }), false);
});
