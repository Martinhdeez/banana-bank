import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseWait, duration, formatDate } from '../src/ui-helpers';

// OPX2-ui: the server's waiting times in words; the level comes from the API, not recomputed here.
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('OPX2-ui duration reads as min, h + min, d + h', () => {
  assert.equal(duration(0), 'under 1 min');
  assert.equal(duration(59_999), 'under 1 min');
  assert.equal(duration(MIN), '1 min');
  assert.equal(duration(12 * MIN + 30_000), '12 min');
  assert.equal(duration(59 * MIN), '59 min');
  assert.equal(duration(HOUR), '1 h');
  assert.equal(duration(3 * HOUR + 5 * MIN), '3 h 5 min');
  assert.equal(duration(DAY), '1 d');
  assert.equal(duration(2 * DAY + 30 * MIN), '2 d');
  assert.equal(duration(6 * DAY + 4 * HOUR + 59 * MIN), '6 d 4 h');
});

const base = {
  asOf: '2026-09-30T12:00:00.000Z',
  openedAt: '2026-09-30T10:30:00.000Z',
  lastCustomerMessageAt: null,
  sinceCustomerMs: null,
  resolvedAt: null,
  thresholds: { warnMinutes: 60, breachMinutes: 240 },
};

test('OPX2-ui open case: wait and level in words, level from the server', () => {
  const title = `Opened ${formatDate(base.openedAt)} · near target after 1 h, target 4 h`;
  assert.deepEqual(caseWait({ ...base, openMs: 5 * MIN, level: 'ok' }), {
    level: 'ok',
    text: 'Waiting 5 min · Within target',
    title,
  });
  assert.equal(
    caseWait({ ...base, openMs: 90 * MIN, level: 'warn' })?.text,
    'Waiting 1 h 30 min · Near target',
  );
  assert.equal(
    caseWait({ ...base, openMs: 3 * DAY, level: 'breach' })?.text,
    'Waiting 3 d · Over target',
  );
  // The server's level wins: no threshold maths on the client.
  assert.equal(caseWait({ ...base, openMs: 5 * MIN, level: 'breach' })?.level, 'breach');
});

test('OPX2-ui closed case: resolution time, or says it was not recorded', () => {
  assert.deepEqual(
    caseWait({ ...base, openMs: null, level: null, resolvedAt: '2026-09-30T13:35:00.000Z' }),
    { level: null, text: 'Resolved after 3 h 5 min', title: `Opened ${formatDate(base.openedAt)}` },
  );
  assert.equal(
    caseWait({ ...base, openMs: null, level: null })?.text,
    'Resolution time not recorded',
  );
  assert.equal(caseWait(undefined), null);
});
