// CF4-ui: the favourite toggle sends the person's main account; unpinning must remove the account
// that is actually pinned, which may be another of that person's accounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { favouriteChange } from '../src/ui-helpers';

const people = [
  { accounts: [{ id: 'acc-carla' }, { id: 'acc-carla-savings' }] },
  { accounts: [{ id: 'acc-bruno' }] },
];

test('CF4-ui: pinning sends the main account', () => {
  assert.deepEqual(favouriteChange(people, [], 'acc-carla', true), ['acc-carla']);
  assert.deepEqual(favouriteChange(people, ['acc-carla-savings'], 'acc-carla', true), [
    'acc-carla',
  ]);
});

test('CF4-ui: unpinning removes every pinned account of that person only', () => {
  assert.deepEqual(
    favouriteChange(people, ['acc-bruno', 'acc-carla-savings'], 'acc-carla', false),
    ['acc-carla-savings'],
  );
  assert.deepEqual(
    favouriteChange(people, ['acc-carla', 'acc-carla-savings', 'acc-bruno'], 'acc-carla', false),
    ['acc-carla', 'acc-carla-savings'],
  );
  assert.deepEqual(favouriteChange(people, ['acc-bruno'], 'acc-bruno', false), ['acc-bruno']);
  // Nothing pinned (stale view): unpinning the main id is a server no-op.
  assert.deepEqual(favouriteChange(people, [], 'acc-carla', false), ['acc-carla']);
});
