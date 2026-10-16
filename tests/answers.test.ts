// F4e, F4d, A1, A3: chat retrieval uses the conversation and the customer's product, and the cited
// sources are returned and stored without raw [doc-id] markers. Deterministic: a local fake of the OpenAI API (OPENAI_BASE_URL)
// records embedding inputs and /responses bodies (what the model receives) and answers citing the
// first document it was given; the bank simulator runs on a free port for the customer's accounts.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fakeOpenAI, say } from './helpers/openai';
import { setupEnv, startSimulator } from './helpers/bank';
const { temp } = await setupEnv('banana-answers-');
// A4: scripted model turns (consumed in order); without a script the model cites the first
// document it was given.
const { server, modelRequests, embeddingInputs, script } = await fakeOpenAI((body) =>
  say(`Documented answer [${/"documentId":"([^"]+)"/.exec(body.instructions)?.[1] ?? 'none'}].`),
);
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const run = await import('../src/agent/run');
const { sessionToken } = await import('../src/auth');
seedApp();
const bank = await startSimulator();
const { newConversation, queryLike } = await import('./helpers/data');

test('F4e: a follow-up question is retrieved with the previous question as context', async () => {
  const id = newConversation('carla');
  await run.sendMessage('carla', id, 'What is the monthly maintenance fee of my Aurora account?');
  await run.sendMessage('carla', id, 'and for Horizon?');
  const query = embeddingInputs.at(-1)!;
  assert.match(query, /Horizon/);
  assert.match(query, /Aurora/);
});

test('F4d: cited sources are returned, stored and listed with the conversation', async () => {
  const id = newConversation('carla');
  const result = (await run.sendMessage('carla', id, 'When is the Aurora fee waived?')) as {
    answer: string;
    sources?: { documentId: string; title: string; version: number }[];
  };
  assert.ok(result.sources, 'sendMessage returns sources');
  assert.equal(result.sources.length, 1);
  const [source] = result.sources;
  assert.ok(source.title && source.version);
  const { GET } = await import('../app/api/[...path]/route');
  const response = await GET(
    new Request(`http://localhost/api/conversations/${id}`, {
      headers: { cookie: `banana_actor=${sessionToken('carla')}` },
    }),
    { params: Promise.resolve({ path: ['conversations', id] }) },
  );
  const { messages } = await response.json();
  assert.deepEqual(messages.at(-1).sources, result.sources);
  assert.deepEqual(messages[0].sources, []);
});

test('F4d: only documents that are cited and were retrieved become sources', () => {
  const citedSources = (run as Record<string, unknown>).citedSources as (
    answer: string,
    pool: { documentId: string }[],
  ) => { documentId: string }[];
  assert.equal(typeof citedSources, 'function');
  const pool = [
    { documentId: 'procedure-1' },
    { documentId: 'procedure-10' },
    { documentId: 'aurora-fees-2026' },
    { documentId: 'aurora-fees-2026' },
  ].map((s) => ({
    ...s,
    id: s.documentId,
    text: '',
    title: 't',
    version: 1,
    validFrom: '2026-09-01',
    validTo: null,
    audience: 'public',
    score: 1,
  }));
  const ids = (answer: string) => citedSources(answer, pool).map((s) => s.documentId);
  assert.deepEqual(ids('Fee is EUR 6 [aurora-fees-2026] per [aurora-fees-2026].'), [
    'aurora-fees-2026',
  ]);
  assert.deepEqual(ids('See [procedure-10] and [invented-doc].'), ['procedure-10']);
  assert.deepEqual(ids('No citation.'), []);
});

const excerpts = (instructions: string) =>
  instructions
    .split('\n')
    .filter((l) => l.startsWith('{"documentId"'))
    .map((l) => JSON.parse(l) as { documentId: string; status: string });

test("A3: the model receives the customer's product document and product, and cites it", async () => {
  // Live evidence 22: Bruno holds a Horizon account; the answer cited aurora-fees-2026.
  const question = queryLike(
    'Just a question: if I sent 50 euros to Carla, would there be any fee?',
    (c) => c.documentId === 'aurora-fees-2026' && c.text.includes('Standard internal transfers'),
  );
  const id = newConversation('bruno');
  const result = await run.sendMessage('bruno', id, question);
  const { instructions } = modelRequests.at(-1)!;
  const ids = excerpts(instructions).map((e) => e.documentId);
  assert.ok(ids.includes('horizon-fees-2026'), ids.join(','));
  assert.ok(ids.indexOf('horizon-fees-2026') < ids.indexOf('aurora-fees-2026'), ids.join(','));
  assert.match(instructions, /customer holds: Horizon account/);
  assert.deepEqual(
    result.sources.map((s) => s.documentId),
    ['horizon-fees-2026'],
  );
});

test('A1: citation markers are stripped, punctuation and non-citations kept', () => {
  const strip = (run as Record<string, unknown>).stripCitations as (
    answer: string,
    pool: { documentId: string }[],
  ) => string;
  assert.equal(typeof strip, 'function');
  const pool = [{ documentId: 'aurora-fees-2026' }, { documentId: 'faq-aurora-waiver' }];
  assert.equal(strip('The fee is EUR 6 [aurora-fees-2026].', pool), 'The fee is EUR 6.');
  assert.equal(
    strip(
      'Waived with salary [aurora-fees-2026, faq-aurora-waiver][faq-aurora-waiver], see below.',
      pool,
    ),
    'Waived with salary, see below.',
  );
  assert.equal(
    strip('See [the guide](https://example.com).', pool),
    'See [the guide](https://example.com).',
  );
  assert.equal(strip('Unverified [invented-doc].', pool), 'Unverified [invented-doc].');
  assert.equal(
    strip('Options: [1] and [aurora-fees-2026 x].', pool),
    'Options: [1] and [aurora-fees-2026 x].',
  );
});

test('A1: the stored, returned and listed answer has no [doc-id] marker; sources stay', async () => {
  const id = newConversation('carla');
  const result = await run.sendMessage('carla', id, 'Is the Aurora fee waived with a salary?');
  const cited = modelRequests.at(-1)!.instructions.match(/"documentId":"([^"]+)"/)![1];
  assert.equal(result.answer, 'Documented answer.');
  assert.deepEqual(
    result.sources.map((s) => s.documentId),
    [cited],
  );
  const stored = appDb()
    .prepare("SELECT content FROM messages WHERE conversation_id=? AND role='assistant'")
    .get(id) as { content: string };
  assert.equal(stored.content, 'Documented answer.');
  const { GET } = await import('../app/api/[...path]/route');
  const response = await GET(
    new Request(`http://localhost/api/conversations/${id}`, {
      headers: { cookie: `banana_actor=${sessionToken('carla')}` },
    }),
    { params: Promise.resolve({ path: ['conversations', id] }) },
  );
  const last = (await response.json()).messages.at(-1);
  assert.doesNotMatch(last.content, /\[[\w-]+\]/);
  assert.deepEqual(last.sources, result.sources);
});

test('A4: the model receives one current public excerpt per document, the question and the accounts', async () => {
  // This passage matches 5 chunks of faq-cancellation: before A2 they filled every slot.
  const question = queryLike(
    'Can I cancel a transfer I already sent?',
    (c) => c.documentId === 'faq-cancellation',
  );
  const id = newConversation('carla');
  await run.sendMessage('carla', id, question);
  const { instructions, input } = modelRequests.at(-1)!;
  const given = excerpts(instructions);
  const ids = given.map((e) => e.documentId);
  assert.equal(given.length, 5);
  assert.equal(new Set(ids).size, 5, ids.join(','));
  assert.equal(ids[0], 'faq-cancellation');
  for (const e of given) {
    assert.equal(e.status, 'current', e.documentId);
    assert.ok(!/^(archive|procedure)-/.test(e.documentId), e.documentId);
  }
  assert.match(instructions, /customer holds: Aurora account/);
  assert.deepEqual(input.at(-1), { role: 'user', content: question });
});

test('A4: a document found through search_documents is a source; invented ids never are', async () => {
  const question = queryLike(
    'What happens if my balance is too low?',
    (c) => c.documentId === 'aurora-fees-2026',
  );
  const toolQuery = queryLike(
    'insufficient funds transfer',
    (c) => c.documentId === 'faq-insufficient-funds',
  );
  script.push(
    () => ({
      type: 'function_call',
      id: 'fc_fake',
      call_id: 'call_fake',
      name: 'search_documents',
      arguments: JSON.stringify({ query: toolQuery, validAt: null }),
      status: 'completed',
    }),
    () => say('The transfer is refused [faq-insufficient-funds], as the rules say [invented-doc].'),
  );
  const id = newConversation('diego');
  const result = await run.sendMessage('diego', id, question);
  const [first, second] = modelRequests.slice(-2);
  assert.ok(!excerpts(first.instructions).some((e) => e.documentId === 'faq-insufficient-funds'));
  const toolOutput = second.input.find((i) => i.type === 'function_call_output')!;
  const toolIds = (JSON.parse(toolOutput.output!).sources as { documentId: string }[]).map(
    (s) => s.documentId,
  );
  assert.equal(toolIds[0], 'faq-insufficient-funds');
  assert.equal(new Set(toolIds).size, toolIds.length, toolIds.join(','));
  assert.deepEqual(
    result.sources.map((s) => s.documentId),
    ['faq-insufficient-funds'],
  );
  assert.equal(result.answer, 'The transfer is refused, as the rules say [invented-doc].');
});

test('A4: an answer without citations stores no sources', async () => {
  script.push(() => say('The documentation does not cover that. I can open a support case.'));
  const id = newConversation('ines');
  const result = await run.sendMessage('ines', id, 'How much do I get for referring a friend?');
  assert.deepEqual(result.sources, []);
  const rows = appDb()
    .prepare(
      'SELECT s.sources FROM message_sources s JOIN messages m ON m.id=s.message_id WHERE m.conversation_id=?',
    )
    .all(id);
  assert.deepEqual(rows, []);
});

after(() => {
  bank.kill();
  closeAppDb();
  server.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
