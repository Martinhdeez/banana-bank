// CF5-ui: the bell's pure helpers (badge, accessible name, item text built on the client).
import test from 'node:test';
import assert from 'node:assert/strict';
import { badgeText, bellLabel, notificationText } from '../app/_components/NotificationBell';
import { formatDate } from '../src/ui-helpers';

test('CF5-ui badge caps at 9+ and the label names the unread count', () => {
  assert.equal(badgeText(1), '1');
  assert.equal(badgeText(9), '9');
  assert.equal(badgeText(10), '9+');
  assert.equal(bellLabel(0), 'Notifications');
  assert.equal(bellLabel(3), 'Notifications, 3 unread');
});

test('CF5-ui item text per kind (plan table)', () => {
  const base = {
    id: 'x',
    at: '2026-09-30T10:00:00.000Z',
    read: false,
    link: { tab: 'transfers' },
  } as const;
  const to = 'Carla Ríos · Aurora account';
  assert.equal(
    notificationText({
      ...base,
      kind: 'transfer_verified',
      status: 'completed',
      amountCents: 1250,
      to,
    }),
    `€12.50 to ${to} was completed by the bank.`,
  );
  assert.equal(
    notificationText({
      ...base,
      kind: 'transfer_verified',
      status: 'failed',
      amountCents: 1250,
      to,
    }),
    `€12.50 to ${to} was not registered by the bank. No money moved.`,
  );
  const expiresAt = '2026-09-30T10:03:00.000Z';
  assert.equal(
    notificationText({ ...base, kind: 'proposal_expiring', amountCents: 500, to, expiresAt }),
    `Confirm or cancel soon: €5.00 to ${to} expires at ${formatDate(expiresAt)}.`,
  );
  assert.equal(
    notificationText({ ...base, kind: 'proposal_expired', amountCents: 500, to, expiresAt }),
    `€5.00 to ${to} expired without confirmation. No money moved.`,
  );
  assert.equal(
    notificationText({
      ...base,
      kind: 'case_resolved',
      link: { tab: 'assistant', conversationId: 'c' },
    }),
    'A support agent marked your request as resolved.',
  );
});
