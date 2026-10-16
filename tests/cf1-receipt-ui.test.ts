// CF1-ui: the "Receipt" link shows only for transfers the receipt API answers (CF1-api rule).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasReceipt } from '../src/ui-helpers';

test('CF1-ui: a receipt only for a transfer sent to the bank and not failed', () => {
  for (const status of ['completed', 'pending_verification', 'processing'])
    assert.equal(hasReceipt({ status, reference: 'ref-1' }), true, status);
  for (const status of ['failed', 'awaiting_confirmation', 'created', 'cancelled', 'expired'])
    assert.equal(hasReceipt({ status, reference: 'ref-1' }), false, status);
  // Never sent: no reference, whatever the status says.
  assert.equal(hasReceipt({ status: 'processing', reference: null }), false);
  assert.equal(hasReceipt({ status: 'completed' }), false);
});
