import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditLine, formatDate } from '../src/ui-helpers';

// INT1-ui: the case rail states whether the recorded steps are as written, in words (not colour).
const legacy = { through: 'e3', count: 3, at: '2026-09-29T10:00:00.000Z' };

test('INT1-ui verified chain reads as verified with the step count', () => {
  assert.deepEqual(auditLine({ status: 'verified', checked: 12, legacy: null, brokenAt: null }), {
    tone: 'verified',
    text: 'Audit log verified · 12 steps across all cases, no changes detected',
    note: null,
  });
  assert.equal(
    auditLine({ status: 'verified', checked: 1, legacy: null, brokenAt: null })?.text,
    'Audit log verified · 1 step across all cases, no changes detected',
  );
});

test('INT1-ui legacy rows add a note, never a stronger claim', () => {
  const line = auditLine({ status: 'verified', checked: 5, legacy, brokenAt: null });
  assert.equal(line?.tone, 'verified');
  assert.equal(
    line?.note,
    `3 steps were recorded before the audit log existed (${formatDate(legacy.at)}): they are known unchanged only since then.`,
  );
});

test('INT1-ui broken chain names the step and its time', () => {
  const at = '2026-09-30T08:15:00.000Z';
  const line = auditLine({
    status: 'broken',
    checked: 2,
    legacy: null,
    brokenAt: { eventId: 'e3', kind: 'tool.completed', at, reason: 'hash_mismatch' },
  });
  assert.equal(line?.tone, 'broken');
  assert.equal(line?.text, `Audit log broken at step tool.completed · ${formatDate(at)}`);
  assert.equal(line?.note, 'Steps from that point may not be as recorded. See Evidence gaps.');
});

test('INT1-ui truncation (head mismatch) has no step to name', () => {
  const line = auditLine({
    status: 'broken',
    checked: 4,
    legacy,
    brokenAt: { eventId: 'e9', kind: null, at: null, reason: 'head_mismatch' },
  });
  assert.equal(line?.text, 'Audit log broken · the newest steps are missing');
});

test('INT1-ui empty log and missing field', () => {
  assert.deepEqual(auditLine({ status: 'empty', checked: 0, legacy: null, brokenAt: null }), {
    tone: 'empty',
    text: 'Audit log empty · no steps recorded yet',
    note: null,
  });
  assert.equal(auditLine(undefined), null);
});
