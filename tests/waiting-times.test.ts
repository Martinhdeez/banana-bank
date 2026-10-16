// OPX2-api: waiting time and SLA level of each case, computed on the server from recorded
// timestamps only (contract: evidence that was never recorded must not be invented).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { callApi, setupEnv, startSimulator } from './helpers/bank';
const { temp } = await setupEnv('banana-waiting-');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb, insert } = await import('../src/db');
const view = (await import('../src/operator/view')) as any;
let bank: ChildProcess;
before(async () => {
  seedBank();
  seedApp();
  bank = await startSimulator();
});
after(() => {
  bank?.kill();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});
const now = new Date('2026-09-30T12:00:00.000Z');
const minutesBefore = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
function openCase(id: string, openedMinutesAgo: number, userMessageMinutesAgo?: number) {
  insert('conversations', {
    id: `conv-${id}`,
    user_id: 'bruno',
    title: id,
    created_at: minutesBefore(openedMinutesAgo),
  });
  if (userMessageMinutesAgo !== undefined)
    insert('messages', {
      id: `msg-${id}`,
      conversation_id: `conv-${id}`,
      role: 'user',
      content: 'Hello?',
      created_at: minutesBefore(userMessageMinutesAgo),
    });
  insert('incidents', {
    id,
    user_id: 'bruno',
    conversation_id: `conv-${id}`,
    summary: id,
    status: 'open',
    created_at: minutesBefore(openedMinutesAgo),
  });
  return appDb().prepare('SELECT * FROM incidents WHERE id=?').get(id);
}

test('OPX2: waitingTimes is exported', () => {
  assert.equal(typeof view.waitingTimes, 'function');
});

test('OPX2: level from the open time with the default 60/240 min thresholds', () => {
  const warn = view.waitingTimes(openCase('case-w90', 90, 30), now);
  assert.equal(warn.level, 'warn');
  assert.equal(warn.openMs, 5_400_000);
  assert.equal(warn.asOf, now.toISOString());
  assert.equal(warn.openedAt, minutesBefore(90));
  assert.equal(warn.lastCustomerMessageAt, minutesBefore(30));
  assert.equal(warn.sinceCustomerMs, 30 * 60_000);
  assert.equal(warn.resolvedAt, null);
  assert.deepEqual(warn.thresholds, { warnMinutes: 60, breachMinutes: 240 });
  assert.equal(view.waitingTimes(openCase('case-w300', 300, 300), now).level, 'breach');
  assert.equal(view.waitingTimes(openCase('case-w10', 10, 10), now).level, 'ok');
  // Edge: exactly at a threshold counts as reached; a future created_at clamps to 0.
  assert.equal(view.waitingTimes(openCase('case-w60', 60, 60), now).level, 'warn');
  const future = view.waitingTimes(openCase('case-future', -5, -5), now);
  assert.equal(future.openMs, 0);
  assert.equal(future.sinceCustomerMs, 0);
  assert.equal(future.level, 'ok');
});

test('OPX2: no recorded customer message is null, not estimated', () => {
  const w = view.waitingTimes(openCase('case-silent', 20), now);
  assert.equal(w.lastCustomerMessageAt, null);
  assert.equal(w.sinceCustomerMs, null);
});

test('OPX2: a resolved case has its resolution time; a seeded closed one has none', async () => {
  openCase('case-to-resolve', 50, 50);
  const detail = await view.resolveCase('marta', 'case-to-resolve', true);
  const event = appDb()
    .prepare("SELECT created_at FROM events WHERE kind='case.resolved' ORDER BY rowid DESC LIMIT 1")
    .get() as { created_at: string };
  const w = detail.incident.waiting;
  assert.equal(w.openMs, null);
  assert.equal(w.level, null);
  assert.equal(w.resolvedAt, event.created_at);
  const seeded = appDb()
    .prepare("SELECT * FROM incidents WHERE id='case-routine-lucia-guide'")
    .get();
  const s = view.waitingTimes(seeded, now);
  assert.equal(s.resolvedAt, null);
  assert.equal(s.level, null);
  assert.equal(s.lastCustomerMessageAt, '2026-09-21T09:28:20.000Z');
});

test('OPX2: inbox rows share one asOf, order unchanged; routes expose waiting', async () => {
  const rows = view.inbox();
  assert.equal(new Set(rows.map((r: any) => r.waiting.asOf)).size, 1);
  // OP2 order is untouched: money first, then open oldest first, closed last newest first.
  const rank: Record<string, number> = { money: 0, open: 1, closed: 2 };
  const expected = [...rows].sort(
    (a: any, b: any) =>
      rank[a.priority] - rank[b.priority] ||
      (a.priority === 'closed' ? -1 : 1) * a.created_at.localeCompare(b.created_at),
  );
  assert.deepEqual(
    rows.map((r: any) => r.id),
    expected.map((r: any) => r.id),
  );
  const seededOpen = rows.find((r: any) => r.id === 'case-lucia');
  assert.equal(seededOpen.waiting.level, 'breach'); // seeded cases are days old: true, not a bug
  const list = await callApi('marta', 'incidents');
  assert.ok(list.body.every((r: any) => r.waiting && 'level' in r.waiting));
  const dash = await callApi('marta', 'dashboard');
  assert.ok(dash.body.incidents.every((r: any) => r.waiting));
  const one = await callApi('marta', 'incidents/case-lucia');
  assert.equal(one.body.incident.waiting.openedAt, '2026-09-23T16:40:00.000Z');
  assert.equal(one.body.incident.statusLabel, 'Open'); // existing fields kept
});
