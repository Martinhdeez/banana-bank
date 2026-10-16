// CF3-ui: the search toolbar's query builder (local day bounds, client-side checks with the
// API's own parser, account only alongside another filter).
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyFilters, movementQuery } from '../app/_components/MovementFilters';

const q = (v: Partial<typeof emptyFilters>, account: string | null = null) =>
  movementQuery({ ...emptyFilters, ...v }, account);

test('CF3-ui no filter, or the account alone, sends no search', () => {
  assert.equal(q({}), null);
  assert.equal(q({ q: '   ' }, 'acc-lucia'), null);
});

test('CF3-ui builds the query; dates are local day bounds sent as instants (S4)', () => {
  const r = q(
    { q: ' Team ', from: '2026-09-01', to: '2026-09-30', min: '1,50', direction: 'sent' },
    'acc-lucia',
  );
  assert.ok(r && 'query' in r);
  const p = new URLSearchParams(r.query);
  assert.equal(p.get('q'), 'Team');
  assert.equal(p.get('from'), new Date(2026, 8, 1).toISOString());
  assert.equal(p.get('to'), new Date(new Date(2026, 9, 1).getTime() - 1).toISOString());
  assert.equal(p.get('min'), '1,50');
  assert.equal(p.get('direction'), 'sent');
  assert.equal(p.get('account'), 'acc-lucia');
});

test('CF3-ui refuses bad input before sending, with the API messages', () => {
  const amount = { error: 'Enter amounts in euros, like 12.50.' };
  assert.deepEqual(q({ min: 'abc' }), amount);
  assert.deepEqual(q({ max: '1e3' }), amount);
  assert.deepEqual(q({ min: '0' }), amount);
  assert.deepEqual(q({ min: '20', max: '10' }), {
    error: 'The minimum amount is above the maximum.',
  });
  assert.deepEqual(q({ from: '2026-09-30', to: '2026-09-01' }), {
    error: 'The start date is after the end date.',
  });
  assert.deepEqual(q({ q: 'x'.repeat(101) }), { error: 'Invalid request data.' });
});
