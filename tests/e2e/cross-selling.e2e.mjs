// XS5 (REQ-XS-23): the one browser check of round 8 — a product suggestion in the chat, from the
// block to the operator's inbox. It needs the demo bank (Bruno's movements) and a model, so it does
// not use the app the runner points at: it starts its own `npm run demo -- --production` on its own
// ports and a fresh data directory, with a local scripted stub as the model (tests/helpers/openai.ts,
// the fake of the node tests). The app is given the stub's address and a made-up key only, and
// nothing starts unless the stub answers: no call can reach a real provider.
//
// Run (after `npm run build`; no app has to be running):
//   node tests/e2e/cross-selling.e2e.mjs
//   XS_E2E_APP_PORT (3940; the bank takes it + 1000); PLAYWRIGHT_* and SHOTS as in the other suites.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { call, fakeOpenAI, say } from '../helpers/openai.ts';
import { launch, SHOTS } from './env.mjs';

const appPort = process.env.XS_E2E_APP_PORT || '3940';
const bankPort = String(Number(appPort) + 1000);
const URL = `http://127.0.0.1:${appPort}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const abort = (why) => {
  console.log(`FAIL env — ${why}`);
  process.exit(1);
};
const healthy = () =>
  fetch(`${URL}/api/health`).then(
    (r) => r.ok,
    () => false,
  );
if (await healthy()) abort(`something already answers on ${URL}; set XS_E2E_APP_PORT`);

// The model: a function of the request alone. It answers a spending question with a read and then
// with the paragraph the server asked for (its marker comes from the instructions, so the stub
// cannot bring an offer of its own), and "Tell me more" with the sheet tool.
const ANSWER = 'Here is what you spent on eating out and leisure.';
const SHEET = 'Here is the product sheet. Nothing is contracted here.';
const { server, modelRequests } = await fakeOpenAI((body) => {
  const last = body.input.at(-1);
  const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
  const marker = body.instructions.match(/marker (\[offer-[\w-]+\])/)?.[1];
  if (last?.type === 'function_call_output')
    return say(
      text?.includes('get_offer_details') || /"validFrom"/.test(last.output ?? '')
        ? SHEET
        : marker
          ? `${ANSWER}\n\n${marker} A suggestion: this product may fit how you use your account.`
          : ANSWER,
    );
  if (/Tell me more about this suggestion/.test(text ?? ''))
    return call('get_offer_details', {
      offerId: body.instructions.match(/OFFER STATE[^\n]*\((offer-[\w-]+)\)/)?.[1],
    });
  // The tool a real model uses for a spending question.
  if (/spend/i.test(text ?? '')) return call('get_spending_summary', { from: null, to: null });
  return say('OK.');
});
const stubUrl = process.env.OPENAI_BASE_URL;
const stubUp = await fetch(`${stubUrl}/embeddings`, {
  method: 'POST',
  body: JSON.stringify({ input: 'ping', model: 'x' }),
}).then(
  (r) => r.ok,
  () => false,
);
if (!stubUp || !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(stubUrl))
  abort('the stub model is not up: nothing was started');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bananabank-e2e-xs-'));
const { DECIDER_API_KEY, ...env } = process.env;
const demo = spawn(process.execPath, ['--import', 'tsx', 'scripts/demo.ts', '--production'], {
  stdio: ['ignore', 'ignore', 'inherit'],
  env: {
    ...env,
    OPENAI_API_KEY: 'test-fake',
    OPENAI_BASE_URL: stubUrl,
    DECIDER: 'none',
    OFFERS: 'on',
    DEMO_APP_PORT: appPort,
    DEMO_BANK_PORT: bankPort,
    DEMO_DATA_DIR: dataDir,
  },
});
const gone = once(demo, 'exit');
let browser;
async function stop(code) {
  await browser?.close();
  demo.kill('SIGTERM'); // scripts/demo.ts stops its own children
  await gone;
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(code);
}
for (let i = 0; i < 90 && demo.exitCode === null && !(await healthy()); i++)
  await new Promise((r) => setTimeout(r, 1000));
if (!(await healthy())) {
  console.log('FAIL env — the demo app did not start (run `npm run build` first)');
  await stop(1);
}

browser = await launch();
async function open(persona, tab = '') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.request.post(`${URL}/api/session`, { data: { userId: persona } });
  await ctx.addInitScript((id) => localStorage.setItem('banana_person', id), persona);
  const page = await ctx.newPage();
  await page.goto(`${URL}/${tab}`);
  await page.waitForSelector(tab ? 'select[aria-label="Conversation"]' : '.page-heading');
  return { ctx, page };
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `xs5-${name}.png`) });
// The assistant's answers on screen (the "thinking" bubble is not one).
const answers = (page) => page.locator('.message.assistant:not(:has(.thinking))');
// Does `act` (a send or a click on a reply) and waits for the answer of that turn.
async function turn(page, act) {
  const before = await answers(page).count();
  await act();
  await page.waitForFunction(
    (n) =>
      document.querySelectorAll('.message.assistant').length > n &&
      !document.querySelector('.thinking'),
    before,
    { timeout: 60_000 },
  );
  return answers(page).nth(before);
}
const send = (page, text) =>
  turn(page, async () => {
    await page.getByLabel('Message the assistant').fill(text);
    await page.getByLabel('Message the assistant').press('Enter');
  });
const click = (page, label) =>
  turn(page, () => page.locator('[data-testid="quick-reply"]', { hasText: label }).last().click());
const replies = (message) => message.locator('[data-testid="quick-reply"]').allInnerTexts();
const QUESTION = 'How much did I spend on eating out and leisure?';
// A new conversation: a first turn (never a suggestion), then the question.
async function ask(page) {
  await page.getByRole('button', { name: '+ New conversation' }).click();
  const first = await send(page, 'Hello');
  const second = await send(page, QUESTION);
  return { first, second };
}
const offerId = async (message) => {
  const card = message.locator('[data-testid="offer-card"]');
  return (await card.count()) ? card.getAttribute('data-offer-id') : null;
};

let shown = null;
try {
  const bruno = await open('bruno', '?tab=assistant');
  const { first, second } = await ask(bruno.page);
  check('first turn: no suggestion', (await offerId(first)) === null);
  shown = await offerId(second);
  check('second question: the suggestion block is shown', shown === 'offer-cashback-card', shown);
  const card = second.locator('[data-testid="offer-card"]');
  const basis = await card.locator('[data-testid="offer-basis"]').innerText();
  check(
    "the block says why, from the customer's own movements",
    /^Why you see this: About €\d+ in \d+ Eating out & leisure payments/.test(basis),
    basis,
  );
  const offered = await replies(second);
  check(
    // XS6: the suggestion and round 7's review reminder ("Review them", "Not now") never share a turn.
    'the three offer replies and no review reminder under the suggestion',
    offered.join('|') === "Tell me more|Not interested|Don't suggest products",
    offered.join('|'),
  );
  const body = await second.locator('.message-body').innerText();
  check(
    'the answer itself holds no [offer-…] marker and keeps its text',
    body.includes(ANSWER) &&
      !body.includes('[offer-') &&
      !(await bruno.page.locator('.messages').innerText()).includes('[offer-'),
    body.slice(0, 120),
  );
  await shot(bruno.page, '1-offered');

  const more = await click(bruno.page, 'Tell me more');
  const sheet = more.locator(`[data-testid="offer-sheet"][data-offer-id="${shown}"]`);
  check('Tell me more: the product sheet is under the answer', (await sheet.count()) === 1);
  await sheet.locator('summary').click();
  const sheetText = await sheet.innerText();
  check(
    'the sheet says what the product is not and that it is demonstration content',
    /What it is not/.test(sheetText) &&
      /Demonstration content written by the project team/.test(sheetText),
  );
  const details = await replies(more);
  check(
    'two replies under the sheet',
    details.join('|') === 'Note my interest|Not interested',
    details.join('|'),
  );
  await more.locator('[data-testid="quick-reply"]').last().scrollIntoViewIfNeeded();
  await shot(bruno.page, '2-sheet');

  const noted = await click(bruno.page, 'Note my interest');
  check('Note my interest: answered, no further replies', (await replies(noted)).length === 0);

  const marta = await open('marta');
  const searched = marta.page.waitForResponse(
    (r) => /\/api\/incidents\?/.test(r.url()) && r.status() === 200,
  );
  await marta.page.getByLabel('Search cases').fill('Product interest');
  await searched;
  await marta.page.locator('.case-list[aria-busy="false"]').waitFor();
  const item = marta.page.locator('.case-item', {
    hasText: 'Product interest: Cashback debit card',
  });
  check('operator inbox: the "Product interest: …" case of Bruno', (await item.count()) === 1);
  await Promise.all([
    marta.page.waitForResponse((r) => /\/api\/incidents\/[^/]+$/.test(r.url())),
    item.click(),
  ]);
  const interest = marta.page.getByText('Interest noted for Cashback debit card').first();
  await interest.waitFor();
  // The event lines are the "Assistant steps" of the evidence rail.
  const text = (await marta.page.locator('.case-rail').innerText()).replace(/\s+/g, ' ');
  check(
    'case detail: the suggestion shown with its basis, the sheet lookup, the interest',
    /Product suggestion shown: Cashback debit card — About €\d+ in \d+ Eating out/.test(text) &&
      text.includes('Product sheet lookup') &&
      text.includes('Interest noted for Cashback debit card; nothing was contracted'),
    text.match(/Product suggestion shown[^·]*|Interest noted[^·]*/g)?.join(' | '),
  );
  check(
    'case detail: the customer clicks are in the conversation',
    (await marta.page.locator('.case-thread').innerText()).includes('Note my interest'),
  );
  await interest.scrollIntoViewIfNeeded();
  await shot(marta.page, '3-operator-case');
  await marta.ctx.close();

  const again = await ask(bruno.page);
  const next = await offerId(again.second);
  check(
    'a new conversation never shows the same offer again (the next one, or none)',
    next !== shown && !(await bruno.page.locator('.messages').innerText()).includes('Cashback'),
    `next: ${next}`,
  );
  await bruno.ctx.close();
  check(
    'every model request was answered by the local stub',
    modelRequests.length > 0,
    `${modelRequests.length} requests`,
  );
} catch (e) {
  check('cross-selling flow', false, `threw: ${e.message.split('\n')[0]}`);
}
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
await stop(failed ? 1 : 0);
