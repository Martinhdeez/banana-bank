// VC1 review fixes: the first transcription after a server start is recorded (the app DB is not
// open yet in a fresh process), and a failing provider is asked once, not retried. The operator's
// preview answer had the same gap: its first request in a fresh process is recorded too.
// A local stand-in answers /v1/audio/transcriptions: no key, no network, no bank.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setupEnv } from './helpers/bank';

const { temp } = await setupEnv('banana-vc1-cold-');
delete process.env.AI_DAILY_CAP_USD; // no cap: nothing else on the route opens the DB
let status = 200;
let requests = 0;
const server = http.createServer(async (req, res) => {
  for await (const _ of req);
  requests++;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  if (req.url?.endsWith('/responses'))
    return res.end(
      JSON.stringify({
        id: 'resp_1',
        object: 'response',
        model: 'gpt-stand-in',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
        ],
        usage: { input_tokens: 50, output_tokens: 2, total_tokens: 52 },
      }),
    );
  res.end(
    status === 200
      ? JSON.stringify({
          text: 'hola',
          usage: { type: 'tokens', input_tokens: 100, output_tokens: 4, total_tokens: 104 },
        })
      : JSON.stringify({ error: { message: 'down' } }),
  );
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.OPENAI_API_KEY = 'vc1-cold-not-a-key';
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const { seedApp } = await import('../src/seed');
const { appDb, appDbOpen, closeAppDb } = await import('../src/db');
const { sessionToken } = await import('../src/auth');
const api = await import('../app/api/[...path]/route');
seedApp();
closeAppDb(); // the state of a server process that has served nothing yet
after(() => {
  server.closeAllConnections();
  server.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

const post = async () =>
  api.POST(
    new Request('http://localhost/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm', cookie: `banana_actor=${sessionToken('lucia')}` },
      body: Buffer.from('ZQAUDIO'),
    }),
    { params: Promise.resolve({ path: ['transcribe'] }) },
  );
const voiceRows = () =>
  appDb().prepare("SELECT outcome FROM ai_usage WHERE consumer='voice' ORDER BY id").all();

test('VC1: the first transcription in a process with the app DB closed leaves one voice row', async () => {
  assert.equal(appDbOpen(), false);
  const response = await post();
  assert.equal(response.status, 200);
  assert.deepEqual(voiceRows(), [{ outcome: 'ok' }]);
});

test('VC1: a retryable provider failure is one billed request and one failed row', async () => {
  status = 500;
  const before = requests;
  const response = await post();
  assert.equal(response.status, 502);
  assert.equal(requests - before, 1);
  assert.deepEqual(voiceRows(), [{ outcome: 'ok' }, { outcome: 'failed' }]);
});

test('VC1 review: the first operator preview in a process with the app DB closed leaves one row', async () => {
  status = 200;
  closeAppDb();
  const response = await api.POST(
    new Request('http://localhost/api/preview-answer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: `banana_actor=${sessionToken('marta')}`,
      },
      body: JSON.stringify({ question: 'q', sources: [] }),
    }),
    { params: Promise.resolve({ path: ['preview-answer'] }) },
  );
  assert.equal(response.status, 200);
  const rows = appDb()
    .prepare("SELECT outcome FROM ai_usage WHERE consumer='operator_preview'")
    .all();
  assert.deepEqual(rows, [{ outcome: 'ok' }]);
});
