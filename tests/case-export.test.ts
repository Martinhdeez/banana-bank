// OPX1-api: case export (evidence bundle). Operator-only JSON and printable HTML built from the case
// detail, saying what was never recorded, with the audit chain status, recorded as case.exported.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { setupEnv, startSimulator } from './helpers/bank';
const { temp } = await setupEnv('banana-export-');
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb, insert } = await import('../src/db');
const { recordEvent } = await import('../src/telemetry');
const { sessionToken } = await import('../src/auth');
const { GET } = await import('../app/api/[...path]/route');
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
async function get(userId: string, path: string, query = '') {
  const request = new Request(`http://localhost/api/${path}${query}`, {
    headers: { cookie: `banana_actor=${sessionToken(userId)}` },
  });
  const response = await GET(request, { params: Promise.resolve({ path: path.split('/') }) });
  return { status: response.status, headers: response.headers, text: await response.text() };
}
const kindCount = (kind: string, incidentId: string) =>
  appDb()
    .prepare("SELECT COUNT(*) FROM events WHERE kind=? AND json_extract(data,'$.incidentId')=?")
    .pluck()
    .get(kind, incidentId) as number;

test('OPX1: JSON bundle with the case, its hash and a verified chain', async () => {
  await get('marta', 'incidents/case-lucia'); // a view: the chain is no longer empty
  const r = await get('marta', 'incidents/case-lucia/export', '?format=json');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type')!, /^application\/json/);
  assert.match(
    r.headers.get('content-disposition')!,
    /^attachment; filename="case-[0-9A-Z]{6}-\d{8}\.json"$/,
  );
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const b = JSON.parse(r.text);
  assert.equal(b.format, 'banana-case-bundle');
  assert.equal(b.version, 1);
  assert.deepEqual(b.exportedBy, { id: 'marta', name: 'Marta Sanz' });
  assert.equal(b.bankVerifiedAt, b.exportedAt);
  assert.equal(b.case.incident.id, 'case-lucia');
  assert.equal(b.case.events, undefined, 'events live inside runs only');
  assert.ok(Array.isArray(b.case.activity));
  assert.equal(
    b.integrity.sha256,
    createHash('sha256').update(JSON.stringify(b.case)).digest('hex'),
  );
  assert.equal(b.integrity.chain.status, 'verified');
  assert.ok(
    b.notRecorded.includes('No assistant runs or tool steps were recorded for this conversation.'),
  );
  assert.ok(b.notRecorded.includes('No assistant handoff summary was recorded.'));
  assert.ok(b.notRecorded.some((s: string) => s.startsWith('This export itself is recorded')));
});

test('OPX1: the export is recorded as case.exported with its sha256, and is not a view', async () => {
  const views = kindCount('case.viewed', 'case-carla');
  const r = await get('marta', 'incidents/case-carla/export');
  assert.equal(r.status, 200, 'json is the default format');
  const b = JSON.parse(r.text);
  const row = appDb()
    .prepare(
      "SELECT data FROM events WHERE kind='case.exported' AND json_extract(data,'$.incidentId')=? ORDER BY rowid DESC LIMIT 1",
    )
    .pluck()
    .get('case-carla') as string;
  assert.deepEqual(JSON.parse(row), {
    incidentId: 'case-carla',
    operatorId: 'marta',
    format: 'json',
    sha256: b.integrity.sha256,
  });
  assert.equal(kindCount('case.viewed', 'case-carla'), views);
  const detail = await get('marta', 'incidents/case-carla');
  const activity = JSON.parse(detail.text).activity;
  assert.ok(activity.some((a: any) => a.description === 'Exported as JSON by Marta Sanz'));
});

test('OPX1: HTML report is self-contained, escaped, and lists "Not recorded" first', async () => {
  insert('messages', {
    id: 'msg-export-html',
    conversation_id: 'conv-elena-support',
    role: 'user',
    content: 'Is <b>x</b> <script>alert(1)</script> fine?',
    created_at: new Date().toISOString(),
  });
  const r = await get('marta', 'incidents/case-elena/export', '?format=html');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(r.headers.get('content-disposition')!, /^attachment; filename="case-.*\.html"$/);
  assert.ok(!/<script/i.test(r.text), 'no script tags, not even from message content');
  assert.ok(r.text.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.ok(!/(src|href)="https?:/.test(r.text), 'no external URLs');
  assert.ok(r.text.indexOf('Not recorded') < r.text.indexOf('Conversation'));
  assert.ok(r.text.includes('Elena Costa'));
  assert.match(r.text, /Case #[0-9A-Z]{6}/);
  assert.equal(kindCount('case.exported', 'case-elena'), 1);
});

// FX6-c: a failed turn is a recorded run with no tool step; the case must not also say that no
// run was recorded.
test('FX6-c: a failed assistant turn is listed as a run, not as an evidence gap', async () => {
  const now = new Date().toISOString(),
    db = appDb();
  db.prepare('INSERT INTO conversations VALUES(?,?,?,?)').run('conv-fx6', 'ines', 'Help', now);
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?)').run(
    'run-fx6',
    'ines',
    'conv-fx6',
    now,
    'failed',
    'Internal (AI provider, not shown to the customer): The AI provider returned 429. <b>',
  );
  db.prepare('INSERT INTO incidents VALUES(?,?,?,?,?,?)').run(
    'case-fx6',
    'ines',
    'conv-fx6',
    'Help',
    'open',
    now,
  );
  const b = JSON.parse((await get('marta', 'incidents/case-fx6/export')).text);
  assert.equal(b.case.runs[0].status, 'failed');
  assert.ok(!b.notRecorded.some((s: string) => /No assistant runs/.test(s)), b.notRecorded.join());
});

test("FX6-d: the HTML report prints a failed turn's error, escaped", async () => {
  const { text } = await get('marta', 'incidents/case-fx6/export', '?format=html');
  assert.ok(
    text.includes(
      'Turn failed · Internal (AI provider, not shown to the customer): The AI provider returned 429. &lt;b&gt;',
    ),
  );
});

test('FX6-e: a handoff summary recorded with bidi controls is shown without them', async () => {
  recordEvent(
    { userId: 'ines', conversationId: 'conv-fx6', runId: 'run-fx6', intentId: '' },
    'tool.completed',
    {
      tool: 'request_human',
      arguments: { summary: 'Help \u202Edesrever' },
      output: { status: 'open', incidentId: 'case-fx6' },
    },
  );
  const { summary } = JSON.parse((await get('marta', 'incidents/case-fx6/export')).text).case;
  assert.deepEqual(
    summary.handoffs.map((h: { summary: string }) => h.summary),
    ['Help desrever'],
  );
  assert.ok(summary.text.includes('Assistant handoff: Help desrever'));
});

test('OPX1: customer 403, unknown case 404, bad or extra query 400; nothing recorded', async () => {
  const count = () => appDb().prepare('SELECT COUNT(*) FROM events').pluck().get() as number;
  const n = count();
  assert.equal((await get('lucia', 'incidents/case-lucia/export')).status, 403);
  assert.equal((await get('marta', 'incidents/no-such-case/export')).status, 404);
  assert.equal((await get('marta', 'incidents/case-lucia/export', '?format=pdf')).status, 400);
  assert.equal(
    (await get('marta', 'incidents/case-lucia/export', '?format=json&format=html')).status,
    400,
  );
  assert.equal((await get('marta', 'incidents/case-lucia/export', '?x=1')).status, 400);
  assert.equal(count(), n);
});

test('OPX1: a tampered event makes the chain "broken" in the bundle', async () => {
  appDb()
    .prepare("UPDATE events SET data=json_set(data,'$.format','html') WHERE kind='case.exported'")
    .run();
  const b = JSON.parse((await get('marta', 'incidents/case-diego/export')).text);
  assert.equal(b.integrity.chain.status, 'broken');
  assert.match(b.integrity.chain.detail, /hash_mismatch/);
});

test('OPX1: bank unreachable, the export still succeeds and says so', async () => {
  bank.kill();
  await new Promise((r) => bank.once('exit', r));
  const r = await get('marta', 'incidents/case-ines/export');
  assert.equal(r.status, 200);
  const b = JSON.parse(r.text);
  assert.ok(b.case.bank.error);
  assert.ok(b.notRecorded.includes(b.case.bank.error));
  // FX2-a: no bank read happened, so the bundle states no bank read time, in either format.
  assert.equal(b.bankVerifiedAt, null);
  const html = (await get('marta', 'incidents/case-ines/export', '?format=html')).text;
  assert.ok(html.includes('<h2>Bank (not read)</h2>'));
  assert.ok(!html.includes('Bank (read'));
});
