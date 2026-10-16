// XS3 — plan 24 §4, §6, REQ-XS-9…18: the product suggestion in a chat turn. Scripted turns on the
// fake OpenAI server (no paid call), the demo bank, DECIDER=none. Hugo holds one Horizon account
// with more than €3,000 and no savings: the server chooses offer-savings-pot from the accounts
// alone, then (DS2: his demo movements hold five payments that repeat every month) offer-bills-watch.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { call, fakeOpenAI, say } from './helpers/openai';
import { callApi, setupEnv, startSimulator } from './helpers/bank';

const { temp } = await setupEnv('banana-xs3-');
Object.assign(process.env, {
  DECIDER: 'none',
  ALT_BANK_SEED_FILE: 'tests/alt-bank/demo-seed.json',
  ALT_BANK_MOVEMENTS_LIMIT: '100',
});
const { server, modelRequests, script } = await fakeOpenAI(() => say('OK.'));
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { config } = await import('../src/config');
const { bankView } = await import('../src/banking/view');
const { offers, OFFER_IDS } = await import('../src/offers/catalogue');
const { cutOffer, offerInstructions } = await import('../src/agent/offers');
const { offerGate } = await import('../src/offers/state');
const { filterInbox, inbox } = await import('../src/operator/view');
const { runTool, toolDefinitions } = await import('../src/agent/tools');
const { categoryLabel } = await import('../src/insights/taxonomy');
const { newConversation } = await import('./helpers/data');
const bank = await startSimulator('alt');
after(() => {
  bank.kill();
  server.close();
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

type Any = Record<string, any>;
const USER = 'hugo';
const pot = offers().find((o) => o.id === 'offer-savings-pot')!;
const ANSWER = 'You hold one Horizon account.';
const PARAGRAPH =
  'A suggestion: the Savings Pot is a separate account to set money aside, which may fit because you keep a balance in your main account.';
const paragraph = (marker = '[offer-savings-pot]', text = PARAGRAPH) =>
  say(`${ANSWER}\n\n${marker} ${text}`);
const suggest = () => paragraph();
const readAccounts = () => call('list_accounts', {});
const events = (kind: string) =>
  (appDb().prepare('SELECT data FROM events WHERE kind=?').all(kind) as { data: string }[]).map(
    (e) => JSON.parse(e.data) as Any,
  );
// One turn through the HTTP route: the POST answer, the stored assistant message as the
// conversation GET sends it, and the instructions of the turn's last model request.
async function turn(
  conversationId: string,
  content: string,
  calls: (() => object)[] = [],
  user = USER,
) {
  script.push(...calls);
  const before = modelRequests.length;
  const post = await callApi(user, `conversations/${conversationId}/messages`, { content });
  assert.equal(post.status, 200, JSON.stringify(post.body));
  const { messages } = (await callApi(user, `conversations/${conversationId}`)).body;
  return {
    answer: post.body.answer as string,
    message: messages.at(-1) as { content: string; sources: Any[]; extras: Any | null },
    instructions: modelRequests.at(-1)!.instructions,
    requests: modelRequests.length - before,
  };
}
// A fresh app and a conversation whose first turn is done (a first turn never gets a suggestion).
async function opened(user = USER) {
  seedApp();
  const conversationId = newConversation(user);
  const first = await turn(conversationId, 'Hello', [], user);
  return { conversationId, first };
}
const labels = (m: { extras: Any | null }) => m.extras?.quickReplies?.map((r: Any) => r.label);

test('REQ-XS-9, 12, 14 a clean second turn: the paragraph is cut, the block is in extras, one offer.shown', async () => {
  const { conversationId, first } = await opened();
  // REQ-XS-12: the gate refuses a first turn, so the model is not told about any product.
  assert.doesNotMatch(first.instructions, /PRODUCT SUGGESTION/);
  assert.equal(first.message.extras, null);

  const t = await turn(conversationId, 'Which accounts do I have?', [readAccounts, suggest]);
  assert.equal(t.requests, 2, 'choosing an offer adds no model request');
  for (const text of [t.answer, t.message.content]) assert.equal(text, ANSWER);
  const basis =
    'Your Horizon account holds more than €3,000 and you have no savings account with us.';
  assert.deepEqual(t.message.extras!.offer, {
    id: pot.id,
    name: 'Savings Pot',
    text: PARAGRAPH,
    basis,
  });
  assert.deepEqual(t.message.extras!.offerSources, [
    { id: pot.id, title: pot.name, version: 1, validFrom: '2026-10-01', text: pot.text },
  ]);
  assert.deepEqual(t.message.extras!.quickReplies, [
    { label: 'Tell me more', value: 'Tell me more about this suggestion' },
    { label: 'Not interested', value: 'Not interested' },
    { label: "Don't suggest products", value: "Don't suggest products to me" },
  ]);
  assert.equal('awaitingOffer' in t.message.extras!, false, 'awaitingOffer is server-only');
  assert.deepEqual(t.message.sources, [], 'a product sheet is not a library source');
  assert.deepEqual(events('offer.shown'), [{ name: pot.name, basis, offerId: pot.id }]);

  // REQ-XS-14: what the offer adds to the instructions is a function of the catalogue offer only.
  assert.ok(t.instructions.endsWith(offerInstructions(pot)));
  const block = t.instructions.slice(t.instructions.indexOf('PRODUCT SUGGESTION'));
  const view = await bankView(USER);
  assert.ok(!t.instructions.includes(basis) && !block.includes('3,000'));
  for (const a of view.accounts as Any[])
    assert.ok(!block.includes(String(a.balanceCents)) && !block.includes(a.label));
  for (const m of view.movements) {
    const key = view.categories.get(m.id)?.merchantKey;
    assert.ok(!block.includes(m.description) && !(key && block.includes(key)), m.description);
  }
});

test('REQ-XS-10 the suggestion is dropped, and still cut, when the turn was not clean', async () => {
  // XS6: a round-7 flow that waits for the customer's answer (here: which category a movement
  // is) still blocks the suggestion. The review nudge no longer does (REQ-XS-26, below).
  const view = await bankView(USER);
  const toSort = view.movements.find((m) => view.categories.get(m.id)?.state === 'needs_review')!;
  const cases: Record<string, (() => object)[]> = {
    'a failed tool': [() => call('search_documents', { query: 1 }), suggest],
    'a transfer tool': [
      () =>
        call('transfer_money', {
          fromAccountId: null,
          recipient: 'Bruno',
          toAccountId: null,
          amountCents: 100,
          concept: 'XS3',
          secondTransfer: null,
          replacesApprovalId: null,
        }),
      suggest,
    ],
    request_human: [() => call('request_human', { summary: 'XS3' }), suggest],
    'round-7 quick replies': [
      () => call('suggest_category_choices', { movementId: toSort.id }),
      suggest,
    ],
    'an answer resting on nothing': [suggest],
  };
  for (const [name, calls] of Object.entries(cases)) {
    const { conversationId } = await opened();
    const t = await turn(conversationId, 'Which accounts do I have?', calls);
    assert.match(t.instructions, /PRODUCT SUGGESTION/, `${name}: the offer was chosen`);
    assert.equal(t.message.content, ANSWER, name);
    assert.equal(t.message.extras?.offer, undefined, name);
    assert.deepEqual(events('offer.shown'), [], name);
    // The category buttons of the awaited movement, whole: one per candidate, then Other, Skip.
    if (name.startsWith('round-7')) {
      const choices = (await runTool(
        'suggest_category_choices',
        { movementId: toSort.id },
        { userId: USER, conversationId, runId: 'xs6-review', intentId: 'xs6-review' },
      )) as Any;
      assert.equal(choices.status, 'ok');
      assert.deepEqual(labels(t.message), [
        ...choices.candidates
          .filter((c: Any) => c.category !== 'other')
          .map((c: Any) => categoryLabel(c.category)),
        'Other',
        'Skip',
      ]);
    } else assert.equal(t.message.extras?.quickReplies, undefined, name);
  }
});

test('REQ-XS-11 the model cannot bring an offer the server did not choose; a figure not in the sheet shows the pitch', async () => {
  for (const marker of ['[offer-cashback-card]', '[offer-gold-card]']) {
    const { conversationId } = await opened();
    const t = await turn(conversationId, 'Which accounts do I have?', [
      readAccounts,
      () => paragraph(marker),
    ]);
    assert.equal(t.message.content, ANSWER, marker);
    assert.equal(t.message.extras, null, marker);
    assert.deepEqual(events('offer.shown'), [], marker);
  }
  const { conversationId } = await opened();
  const t = await turn(conversationId, 'Which accounts do I have?', [
    readAccounts,
    () => paragraph(undefined, 'A suggestion: the Savings Pot pays 3.5% a year.'),
  ]);
  assert.equal(t.message.extras!.offer.text, pot.pitch);
  // A figure of the sheet is allowed.
  const again = await opened();
  const ok = 'A suggestion: the Savings Pot pays 1.25% a year.';
  const kept = await turn(again.conversationId, 'Which accounts do I have?', [
    readAccounts,
    () => paragraph(undefined, ok),
  ]);
  assert.equal(kept.message.extras!.offer.text, ok);
});

test('REQ-XS-15, 17 "Not interested" and "Don\'t suggest products" are recorded by the server; the next conversation gets the next offer', async () => {
  const { conversationId } = await opened();
  await turn(conversationId, 'Which accounts do I have?', [readAccounts, suggest]);
  // The stub model calls no tool: the click is applied before it runs.
  const declined = await turn(conversationId, 'Not interested');
  assert.deepEqual(events('offer.declined'), [{ name: pot.name, offerId: pot.id }]);
  assert.match(declined.instructions, /OFFER STATE.*"Savings Pot".*Not interested/);
  assert.doesNotMatch(declined.instructions, /PRODUCT SUGGESTION/, 'one offer per conversation');
  assert.equal(declined.message.extras, null);

  // REQ-XS-17: another conversation gets the next offer in order, never the one already shown.
  const second = newConversation(USER);
  await turn(second, 'Hello');
  config.offersCooldownDays = 1;
  const cooled = await turn(second, 'Which accounts do I have?', [readAccounts, suggest]);
  config.offersCooldownDays = 0;
  assert.doesNotMatch(cooled.instructions, /PRODUCT SUGGESTION/, 'inside the cool-down');
  const next = await turn(second, 'And what does it cost?', [
    readAccounts,
    () => paragraph('[offer-bills-watch]', 'A suggestion: Bills Watch lists what repeats.'),
  ]);
  assert.match(next.instructions, /PRODUCT SUGGESTION[^]*\[offer-bills-watch\]/);
  assert.doesNotMatch(next.instructions, /\[offer-savings-pot\]/);
  assert.equal(next.message.extras!.offer.id, 'offer-bills-watch');
  assert.match(next.message.extras!.offer.basis, /payments repeat every month/);

  // REQ-XS-15: the opt-out, then no suggestion in any later turn until it is turned on again.
  await turn(second, "Don't suggest products to me");
  assert.equal(events('offer.declined').length, 2);
  assert.equal(events('offers.disabled').length, 1);
  // The gate is asked directly: it is what every later turn asks.
  const third = newConversation(USER);
  await turn(third, 'Hello');
  const gate = () =>
    offerGate({
      userId: USER,
      conversationId: third,
      content: 'x',
      attached: false,
      awaiting: false,
    });
  assert.deepEqual(gate(), { ok: false, reason: 'disabled' });
  const off = await turn(third, 'Which accounts do I have?', [readAccounts, suggest]);
  assert.doesNotMatch(off.instructions, /PRODUCT SUGGESTION/);
  assert.equal(off.message.content, ANSWER, 'a paragraph the server did not ask for is cut too');
  assert.equal(off.message.extras, null);
  await turn(third, 'Turn suggestions on', [
    () => call('set_product_suggestions', { enabled: true }),
  ]);
  assert.equal(events('offers.enabled').length, 1);
  assert.deepEqual(gate(), { ok: true });
});

test('REQ-XS-16 "Tell me more" gives the sheet and the details replies; "Note my interest" opens the case', async () => {
  const { conversationId } = await opened();
  await turn(conversationId, 'Which accounts do I have?', [readAccounts, suggest]);
  const more = await turn(conversationId, 'Tell me more about this suggestion', [
    () => call('get_offer_details', { offerId: pot.id }),
    () => say('The Savings Pot has no fee [offer-savings-pot]. Nothing is contracted here.'),
  ]);
  assert.match(more.instructions, /OFFER STATE.*call get_offer_details/);
  assert.equal(more.message.content, 'The Savings Pot has no fee. Nothing is contracted here.');
  assert.deepEqual(
    more.message.extras!.offerSources.map((s: Any) => [s.id, s.text]),
    [[pot.id, pot.text]],
  );
  assert.equal(more.message.extras!.offer, undefined);
  assert.deepEqual(labels(more.message), ['Note my interest', 'Not interested']);
  assert.deepEqual(more.message.sources, []);

  const noted = await turn(conversationId, 'Note my interest');
  const [interest] = events('offer.interest');
  assert.equal(interest.offerId, pot.id);
  assert.match(noted.instructions, new RegExp(`OFFER STATE.*support case ${interest.incidentId}`));
  const cases = filterInbox(inbox(), { q: 'product interest' }); // GET /api/incidents?q=…
  assert.equal(cases.length, 1);
  assert.equal(cases[0].id, interest.incidentId);
  assert.match(cases[0].summary, /^Product interest: Savings Pot\./);
  assert.equal(events('offer.shown').length, 1);
});

test('REQ-XS-18 the offer id is an enum; the three tools are chat only', async () => {
  seedApp();
  const ctx = { userId: USER, conversationId: newConversation(USER), runId: 'r', intentId: 'i' };
  const bad = (await runTool('get_offer_details', { offerId: 'offer-gold-card' }, ctx)) as Any;
  assert.deepEqual([bad.status, bad.code], ['failed', 'invalid_request']);
  const good = (await runTool('get_offer_details', { offerId: 'offer-cloud-account' }, ctx)) as Any;
  assert.equal(good.status, 'ok');
  // The Cloud offer cites six fee documents: only Cloud's and the customer's own product's.
  assert.deepEqual(
    good.sources.map((s: Any) => s.documentId),
    ['offer-cloud-account', 'cloud-fees-2026', 'horizon-fees-2026'],
  );
  for (const name of ['get_offer_details', 'offer_response', 'set_product_suggestions']) {
    const tool = toolDefinitions.find((t) => t.name === name) as Any;
    assert.ok(tool?.strict, name);
    if (name !== 'set_product_suggestions')
      assert.deepEqual(tool.parameters.properties.offerId.enum, [...OFFER_IDS]);
    const api = await callApi(USER, 'actions', { name, arguments: { offerId: pot.id } });
    assert.equal(api.status, 400, name);
  }
  assert.deepEqual(events('offer.interest'), []);
});

// Review of #117 — D7 "at most one offer per conversation, never insisting": a conversation in
// which the customer answered about a product in words, or asked about one, gets no suggestion.
test('D7 no suggestion later in a conversation where the customer declined in words or asked about a product', async () => {
  const typed: Record<string, object> = {
    offer_response: { offerId: 'offer-cashback-card', response: 'declined' },
    get_offer_details: { offerId: 'offer-cashback-card' },
  };
  for (const [name, args] of Object.entries(typed)) {
    const { conversationId } = await opened();
    await turn(conversationId, 'About the cashback card', [() => call(name, args)]);
    const t = await turn(conversationId, 'Which accounts do I have?', [readAccounts, suggest]);
    assert.doesNotMatch(t.instructions, /PRODUCT SUGGESTION/, name);
    assert.equal(t.message.content, ANSWER, name);
    assert.equal(t.message.extras, null, name);
    assert.deepEqual(events('offer.shown'), [], name);
  }
});

// XS6 — found by the live-model check (REQ-XS-19): the real model calls get_spending_summary on a
// spending question, and with unresolved movements that turn always carried the review nudge, so
// the suggestion was dropped on exactly the turn it is for. Bruno on the demo bank: the server
// chooses offer-cashback-card once the turn has read the movements.
const SPENT = 'You spent €99.10 on restaurants and leisure. 9 movements are unclassified.';
const summary = () => call('get_spending_summary', { from: null, to: null });
const NUDGE = /offer to review them/;
const NO_NUDGE = /already made in this conversation/;

test('REQ-XS-26, 25 a spending turn shows the suggestion, not the review nudge; the nudge comes once, later, and never after "Not now"', async () => {
  const { conversationId } = await opened('bruno');
  const b = (content: string, calls: (() => object)[] = []) =>
    turn(conversationId, content, calls, 'bruno');
  const card = '[offer-cashback-card] A suggestion: the Cashback debit card may fit your spending.';

  const spending = await b('How much did I spend on restaurants and leisure?', [
    summary,
    () => say(`${SPENT}\n\n${card}`),
  ]);
  assert.equal(spending.requests, 2);
  assert.equal(spending.message.content, SPENT);
  assert.equal(spending.message.extras?.offer?.id, 'offer-cashback-card');
  assert.deepEqual(labels(spending.message), [
    'Tell me more',
    'Not interested',
    "Don't suggest products",
  ]);
  assert.match(spending.instructions, /do not invite the customer to review/);
  assert.doesNotMatch(spending.instructions, NUDGE);
  assert.equal(events('offer.shown').length, 1);

  // The next spending turn: the conversation had its suggestion; the nudge was not used up.
  const again = await b('And on groceries?', [summary, () => say(`${SPENT}\n\n${card}`)]);
  assert.doesNotMatch(again.instructions, /PRODUCT SUGGESTION/);
  assert.match(again.instructions, NUDGE);
  assert.equal(again.message.content, SPENT);
  assert.equal(again.message.extras?.offer, undefined);
  assert.deepEqual(labels(again.message), ['Review them', 'Not now']);

  const declined = await b('Not now');
  assert.equal(declined.message.extras, null);
  const later = await b('And on transport?', [summary, () => say(SPENT)]);
  assert.match(later.instructions, NO_NUDGE);
  assert.doesNotMatch(later.instructions, NUDGE);
  assert.equal(later.message.extras?.quickReplies, undefined);
  assert.equal(events('offer.shown').length, 1);
});

test('REQ-XS-25 without a suggestion in play, the review nudge is attached once per conversation', async () => {
  config.offers = 'off';
  try {
    const { conversationId } = await opened('bruno');
    const ask = () => turn(conversationId, 'How much did I spend?', [summary], 'bruno');
    const first = await ask();
    assert.match(first.instructions, NUDGE);
    assert.deepEqual(labels(first.message), ['Review them', 'Not now']);
    const second = await ask();
    assert.match(second.instructions, NO_NUDGE);
    assert.equal(second.message.extras?.quickReplies, undefined);
    // Another conversation starts again.
    const other = newConversation('bruno');
    const fresh = await turn(other, 'How much did I spend?', [summary], 'bruno');
    assert.deepEqual(labels(fresh.message), ['Review them', 'Not now']);
  } finally {
    config.offers = 'on';
  }
});

test('XS5 the cut leaves no separator behind: a rule or dash the model wrote before its paragraph goes with it', () => {
  const P = '[offer-savings-pot] A suggestion: the Savings Pot.';
  for (const [before, kept] of [
    ['No confirmed amounts.–\n\n', 'No confirmed amounts.'],
    ['No confirmed amounts.\n\n---\n\n', 'No confirmed amounts.'],
    ['No confirmed amounts.\n\n* * *\n', 'No confirmed amounts.'],
    ['You spent **€99.10**\n\n', 'You spent **€99.10**'], // closing emphasis is not a separator
    ['- rent\n- power\n\n', '- rent\n- power'],
  ])
    assert.equal(cutOffer(before + P, 'offer-savings-pot').answer, kept);
  // No cut, no trim.
  assert.equal(cutOffer('Nothing here —', 'offer-savings-pot').answer, 'Nothing here —');
});
