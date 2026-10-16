import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityNote, formatDate } from '../src/ui-helpers';

// OPX4-ui: the case activity card says when view/export recording started, never implying
// "nobody looked" before it.
const since = '2026-09-30T10:00:00.000Z';

test('OPX4-ui case opened before recording started: names the start time', () => {
  assert.equal(
    activityNote(since, '2026-09-29T08:00:00.000Z'),
    `Views and exports are recorded since ${formatDate(since)}. Earlier ones were not recorded.`,
  );
});

test('OPX4-ui case opened after recording started: no note', () => {
  assert.equal(activityNote(since, '2026-09-30T10:00:00.000Z'), null);
  assert.equal(activityNote(since, '2026-09-30T11:00:00.000Z'), null);
});

test('OPX4-ui no start time recorded: generic note', () => {
  assert.equal(
    activityNote(null, '2026-09-30T11:00:00.000Z'),
    'Views and exports before this version were not recorded.',
  );
  assert.equal(
    activityNote(undefined, '2026-09-30T11:00:00.000Z'),
    'Views and exports before this version were not recorded.',
  );
});
