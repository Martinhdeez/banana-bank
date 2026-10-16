// OPX4-api: case activity log. Operator views (throttled), resolutions and exports are recorded as
// hash-chained events and listed in the case detail; views never recorded before this version are
// stated as such (activitySince), never invented.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { callApi, setupEnv, startSimulator } from './helpers/bank';
const { temp } = await setupEnv('banana-activity-');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb, insert } = await import('../src/db');
const { verifyAuditChain } = await import('../src/audit');
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
const views = (incidentId: string, operatorId = 'marta') =>
  appDb()
    .prepare(
      "SELECT COUNT(*) FROM events WHERE kind='case.viewed' AND json_extract(data,'$.incidentId')=? AND json_extract(data,'$.operatorId')=?",
    )
    .pluck()
    .get(incidentId, operatorId) as number;

test('OPX4: migrations 3 and 4 are recorded with their fixed names', () => {
  const names = appDb()
    .prepare('SELECT name FROM schema_migrations WHERE version IN (3,4) ORDER BY version')
    .pluck()
    .all();
  assert.deepEqual(names, ['opx4-activity-since', 'opx4-events-incident-index']);
});

test('OPX4: activitySince is set after seedApp', async () => {
  const d = await view.caseDetail('marta', 'case-lucia');
  assert.match(d.activitySince, /^\d{4}-\d\d-\d\dT/);
});

test('OPX4: viewCase records one view per operator and case per 10 minutes', async () => {
  assert.equal(typeof view.viewCase, 'function');
  await view.viewCase('marta', 'case-carla');
  await view.viewCase('marta', 'case-carla');
  assert.equal(views('case-carla'), 1, 'second view inside the window is not recorded');
  await view.viewCase('pablo', 'case-carla');
  assert.equal(views('case-carla', 'pablo'), 1, 'another operator has their own window');
  // An older view only (clock moved): chained through insert(), like every event.
  insert('events', {
    id: 'view-old-elena',
    run_id: 'run-view-old-elena',
    user_id: 'marta',
    conversation_id: 'conv-elena-support',
    kind: 'case.viewed',
    data: JSON.stringify({ incidentId: 'case-elena', operatorId: 'marta' }),
    created_at: new Date(Date.now() - 11 * 60_000).toISOString(),
  });
  await view.viewCase('marta', 'case-elena');
  assert.equal(views('case-elena'), 2, 'a view older than 10 minutes does not throttle');
});

test('OPX4: activity lists views newest first; events and runs never show them', async () => {
  const d = await view.viewCase('marta', 'case-diego');
  assert.equal(d.activity[0].kind, 'case.viewed');
  assert.equal(d.activity[0].operatorId, 'marta');
  assert.equal(d.activity[0].operatorName, 'Marta Sanz');
  assert.equal(d.activity[0].description, 'Viewed by Marta Sanz');
  assert.ok(!d.events.some((e: any) => e.kind === 'case.viewed'));
  assert.ok(!d.runs.some((r: any) => r.events.some((e: any) => e.kind === 'case.viewed')));
});

test('OPX4: resolveCase shows "Marked resolved by" and records no view', async () => {
  const before = views('case-ines');
  const d = await view.resolveCase('marta', 'case-ines', true);
  assert.equal(views('case-ines'), before, 'resolving is not a view');
  const resolved = d.activity.find((a: any) => a.kind === 'case.resolved');
  assert.equal(resolved.description, 'Marked resolved by Marta Sanz');
  assert.ok(
    d.events.some((e: any) => e.kind === 'case.resolved'),
    'still in events (compat)',
  );
});

test('OPX4: activity is by incident, never by conversation', async () => {
  const d = await view.caseDetail('marta', 'case-routine-lucia-guide');
  assert.ok(d.activity.every((a: any) => a.kind !== 'case.viewed' || a.at));
  assert.ok(!d.activity.some((a: any) => a.description.includes('case-lucia')));
  const other = await view.viewCase('marta', 'case-routine-lucia-request');
  assert.ok(other.activity.length >= 1);
  const lucia = await view.caseDetail('marta', 'case-lucia');
  assert.ok(
    !lucia.activity.some((a: any) => a.id === other.activity[0].id),
    'a view of one case does not appear on another',
  );
});

test('OPX4: GET /api/incidents/:id records a view; a customer gets 403 and writes nothing', async () => {
  const count = () => appDb().prepare('SELECT COUNT(*) FROM events').pluck().get() as number;
  const n = count();
  const refused = await callApi('lucia', 'incidents/case-routine-bruno-request');
  assert.equal(refused.status, 403);
  assert.equal(count(), n);
  const ok = await callApi('marta', 'incidents/case-routine-bruno-request');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.activity[0].description, 'Viewed by Marta Sanz');
  assert.equal(views('case-routine-bruno-request'), 1);
  assert.equal((await callApi('marta', 'incidents/no-such-case')).status, 404);
  assert.equal(verifyAuditChain().status, 'verified', 'every activity row is chained');
});
