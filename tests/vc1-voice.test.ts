// VC1: voice input for the chat, server side. POST /api/transcribe turns a browser recording into
// text through the OpenAI transcription API; GET /api/session says whether the UI may offer it.
// A local stand-in answers /v1/audio/transcriptions: no key, no network, no bank.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setupEnv } from './helpers/bank';

const { temp } = await setupEnv('banana-vc1-');
process.env.AI_DAILY_CAP_USD = '0.01'; // 10,000,000 nano-dollars a day
// What the stand-in does with the next request: answer with this transcript, or fail.
let mode: { text: string } | { status: number } = { text: '  Hola, ZQTRANSCRIPT gastos  ' };
const received: { path: string; type: string; body: Buffer }[] = [];
const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  received.push({
    path: req.url ?? '',
    type: req.headers['content-type'] ?? '',
    body: Buffer.concat(chunks),
  });
  res.setHeader('Content-Type', 'application/json');
  if ('status' in mode) {
    res.writeHead(mode.status, { 'x-should-retry': 'false' });
    return res.end(JSON.stringify({ error: { message: 'PROVIDER-BODY sk-proj-abcdefghijkl' } }));
  }
  res.end(
    JSON.stringify({
      text: mode.text,
      usage: {
        type: 'tokens',
        input_tokens: 120,
        input_token_details: { audio_tokens: 120, text_tokens: 0 },
        output_tokens: 8,
        total_tokens: 128,
      },
    }),
  );
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const KEY = 'vc1-test-not-a-key';
process.env.OPENAI_API_KEY = KEY;
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { config } = await import('../src/config');
const { sessionToken } = await import('../src/auth');
const api = await import('../app/api/[...path]/route');
seedApp();
after(() => {
  server.closeAllConnections();
  server.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

const AUDIO = Buffer.from('ZQAUDIOBYTES-webm-opus-recording');
const cookie = (userId: string) => `banana_actor=${sessionToken(userId)}`;
async function read(response: Response) {
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function transcribe(
  userId: string,
  body: BodyInit | null,
  type = 'audio/webm;codecs=opus',
  headers: Record<string, string> = {},
) {
  const request = new Request('http://localhost/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': type, cookie: cookie(userId), ...headers },
    body,
    ...(body instanceof ReadableStream && { duplex: 'half' }),
  } as RequestInit);
  return read(await api.POST(request, { params: Promise.resolve({ path: ['transcribe'] }) }));
}
async function get(userId: string, route: string) {
  const request = new Request(`http://localhost/api/${route}`, {
    headers: { cookie: cookie(userId) },
  });
  return read(
    await api.GET(request, { params: Promise.resolve({ path: route.split('?')[0].split('/') }) }),
  );
}
const voiceRows = () =>
  appDb().prepare("SELECT * FROM ai_usage WHERE consumer='voice' ORDER BY id").all() as Record<
    string,
    any
  >[];
// Every console line a request writes, joined: what the server log would hold.
function capture(t: { mock: { method: Function } }) {
  const lines: string[] = [];
  for (const level of ['info', 'warn', 'error'] as const)
    t.mock.method(console, level, (...args: unknown[]) => lines.push(args.join(' ')));
  return () => lines.join('\n');
}

test('VC1: a customer recording comes back as trimmed text, with one usage row and nothing logged of it', async (t) => {
  const logged = capture(t);
  const before = received.length;
  const r = await transcribe('lucia', AUDIO);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { text: 'Hola, ZQTRANSCRIPT gastos' });
  // One provider request, to the transcription endpoint, carrying the audio and the model.
  assert.equal(received.length, before + 1);
  const sent = received.at(-1)!;
  assert.match(sent.path, /\/v1\/audio\/transcriptions$/);
  assert.match(sent.type, /^multipart\/form-data/);
  assert.ok(sent.body.includes(AUDIO));
  assert.ok(sent.body.includes('gpt-4o-mini-transcribe'));
  // TR1: one row for the customer, no conversation, the provider's tokens, priced at
  // US$ 1.25 per million input tokens and US$ 5 per million output tokens: 120×1250 + 8×5000.
  const rows = voiceRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, 'customer');
  assert.equal(rows[0].user_id, 'lucia');
  assert.equal(rows[0].conversation_id, null);
  assert.equal(rows[0].outcome, 'ok');
  assert.equal(rows[0].model, 'gpt-4o-mini-transcribe');
  assert.equal(rows[0].input_tokens, 120);
  assert.equal(rows[0].output_tokens, 8);
  assert.equal(rows[0].cost_basis, 'estimated');
  assert.equal(rows[0].cost_nano_usd, 190_000);
  // Neither the audio nor the transcript is logged or stored.
  const stored = JSON.stringify(appDb().prepare('SELECT * FROM ai_usage').all());
  for (const secret of ['ZQTRANSCRIPT', 'ZQAUDIOBYTES'])
    assert.ok(!logged().includes(secret) && !stored.includes(secret), secret);
  assert.match(logged(), /voice_ok/);
});

test('VC1: the operator usage report lists the voice consumer for that customer', async () => {
  const r = await get('marta', 'usage?customer=lucia&period=today');
  assert.equal(r.status, 200);
  assert.ok(r.body.byConsumer.some((c: { consumer: string }) => c.consumer === 'voice'));
});

test('VC1: an operator cannot transcribe', async () => {
  const before = received.length;
  const r = await transcribe('marta', AUDIO);
  assert.equal(r.status, 403);
  assert.equal(received.length, before);
});

test('VC1: an empty recording is a 400 and calls no provider', async () => {
  const before = received.length;
  assert.equal((await transcribe('lucia', new Uint8Array(0))).status, 400);
  assert.equal(received.length, before);
});

test('VC1: a body that is not one of the audio types is a 400', async () => {
  for (const type of ['application/json', 'text/plain', 'video/webm', 'audio/flac']) {
    const r = await transcribe('lucia', AUDIO, type);
    assert.equal(r.status, 400, type);
  }
});

test('VC1: every listed audio type is accepted, parameters included', async () => {
  for (const type of [
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
    'audio/mpeg',
    'audio/wav',
  ])
    assert.equal((await transcribe('lucia', AUDIO, type)).status, 200, type);
});

test('VC1: over 2 MB is a 413 "Recording too long." by header and by counting the stream', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const before = received.length;
  // A declared length over the limit is refused before the body is read.
  const declared = await transcribe('lucia', AUDIO, 'audio/webm', {
    'Content-Length': String(3 * 1024 * 1024),
  });
  assert.equal(declared.status, 413);
  assert.deepEqual(declared.body, { error: 'Recording too long.' });
  // No Content-Length: the stream is counted and cut once it passes the limit.
  let sentBytes = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sentBytes > 8 * 1024 * 1024) return controller.close();
      sentBytes += 256 * 1024;
      controller.enqueue(new Uint8Array(256 * 1024));
    },
  });
  const streamed = await transcribe('lucia', stream);
  assert.equal(streamed.status, 413);
  assert.deepEqual(streamed.body, { error: 'Recording too long.' });
  assert.ok(sentBytes <= 3 * 1024 * 1024, `read ${sentBytes} bytes`);
  // Exactly 2 MB is accepted.
  assert.equal((await transcribe('lucia', new Uint8Array(2 * 1024 * 1024).fill(1))).status, 200);
  assert.equal(received.length, before + 1);
});

test('VC1: with no model key voice is unavailable: 503 and session.voice false', async () => {
  const before = received.length;
  delete process.env.OPENAI_API_KEY;
  try {
    const r = await transcribe('lucia', AUDIO);
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, {
      error: 'Voice input is not available.',
      code: 'voice_unavailable',
    });
    assert.equal((await get('lucia', 'session')).body.voice, false);
  } finally {
    process.env.OPENAI_API_KEY = KEY;
  }
  assert.equal(received.length, before);
});

test('VC1: VOICE=off makes voice unavailable', async () => {
  const saved = config.voice;
  config.voice = 'off';
  try {
    assert.equal((await transcribe('lucia', AUDIO)).body.code, 'voice_unavailable');
    assert.equal((await get('lucia', 'session')).body.voice, false);
  } finally {
    config.voice = saved;
  }
});

test('VC1: session.voice is true for a customer with a key, false for an operator; other fields kept', async () => {
  const customer = await get('lucia', 'session');
  assert.equal(customer.status, 200);
  assert.equal(customer.body.voice, true);
  assert.equal(customer.body.person.id, 'lucia');
  const operator = await get('marta', 'session');
  assert.equal(operator.body.voice, false);
  assert.equal(operator.body.person.id, 'marta');
});

test('VC1: a customer at the daily AI cap gets the assistant cap answer and no provider request', async () => {
  appDb()
    .prepare(
      `INSERT INTO ai_usage(created_at,actor,user_id,consumer,seq,attempt,outcome,model,host,input_tokens,output_tokens,tools,cost_nano_usd,cost_basis)
       VALUES(?,'customer','bruno','assistant',1,1,'ok','m','h',1,0,'[]',20000000,'estimated')`,
    )
    .run(new Date().toISOString());
  const before = received.length;
  const r = await transcribe('bruno', AUDIO);
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, {
    error:
      'The assistant is not available for the rest of today. Your accounts, transfers and confirmations still work from the other tabs, and you can ask for human support here.',
    code: 'ai_daily_limit',
  });
  assert.equal(received.length, before);
});

test('VC1: a provider failure is a 502, recorded as failed, with no provider text logged', async (t) => {
  const logged = capture(t);
  const rows = voiceRows().length;
  mode = { status: 500 };
  try {
    const r = await transcribe('carla', AUDIO);
    assert.equal(r.status, 502);
    assert.deepEqual(r.body, {
      error: 'Could not transcribe the recording.',
      code: 'transcription_failed',
    });
  } finally {
    mode = { text: 'ok' };
  }
  const row = voiceRows().at(-1)!;
  assert.equal(voiceRows().length, rows + 1);
  assert.equal(row.user_id, 'carla');
  assert.equal(row.outcome, 'failed');
  assert.match(logged(), /voice_failed/);
  assert.match(logged(), /"status":500/);
  assert.doesNotMatch(logged(), /PROVIDER-BODY|sk-proj|ZQAUDIOBYTES/);
});

test('VC1: the migration keeps every recorded row and then accepts the voice consumer', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { migrations } = await import('../src/db');
  const db = new Database(':memory:');
  const index = migrations.findIndex((m) => m.name === 'vc1-voice-consumer');
  for (const m of migrations.slice(0, index)) m.up(db);
  const insert = (consumer: string) =>
    db
      .prepare(
        `INSERT INTO ai_usage(created_at,actor,user_id,consumer,seq,attempt,outcome,model,host,tools,cost_basis)
         VALUES('t','customer','lucia',?,1,1,'ok','m','h','[]','unpriced')`,
      )
      .run(consumer);
  insert('assistant');
  assert.throws(() => insert('voice'), /CHECK constraint/);
  migrations[index].up(db);
  insert('voice');
  assert.deepEqual(db.prepare('SELECT id,consumer FROM ai_usage ORDER BY id').all(), [
    { id: 1, consumer: 'assistant' },
    { id: 2, consumer: 'voice' },
  ]);
  db.close();
});
