// PT4 (REQ-PT-18): the one browser check of round 9 — prepared transfers, in the page and in the
// chat, down to the operator's case. Like cross-selling.e2e.mjs it does not use the app the runner
// points at: it starts its own `npm run demo -- --production` on its own ports and a fresh data
// directory, with a local scripted stub as the model (tests/helpers/openai.ts). The app is given
// the stub's address and a made-up key only, and nothing starts unless the stub answers: no call
// can reach a real provider. What the stub says is not checked; what the app did is.
//
// Run (after `npm run build`; no app has to be running):
//   node tests/e2e/prepared-transfers.e2e.mjs
//   PT_E2E_APP_PORT (3945; the bank takes it + 1000); PLAYWRIGHT_* and SHOTS as in the other suites.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { call, fakeOpenAI, say } from '../helpers/openai.ts';
import { launch, SHOTS } from './env.mjs';

const appPort = process.env.PT_E2E_APP_PORT || '3945';
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
if (await healthy()) abort(`something already answers on ${URL}; set PT_E2E_APP_PORT`);

// The model: a function of the request alone. It prepares when asked to prepare, lists and then
// sends when told the keys arrived (the id comes from the list result, never from the stub), and
// opens a case when asked for a person.
const NOTE = 'when I get the keys';
const { server, modelRequests } = await fakeOpenAI((body) => {
  const last = body.input.at(-1);
  if (last?.type === 'function_call_output') {
    const out = JSON.parse(last.output ?? '{}');
    if (Array.isArray(out.prepared)) {
      const match = out.prepared.find((p) => p.note === NOTE);
      return match
        ? call('send_prepared_transfer', { preparedId: match.id })
        : say('I found no prepared transfer for that.');
    }
    if (out.status === 'prepared') return say('It is prepared, not sent.');
    if (out.status === 'requires_confirmation') return say('Review and confirm it below.');
    return say('Done.');
  }
  const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
  if (/^Prepare/.test(text ?? ''))
    return call('prepare_transfer', {
      fromAccountId: null,
      recipient: 'Lucía',
      toAccountId: null,
      amountCents: 2000,
      concept: 'Keys deposit',
      note: NOTE,
      when: 'manual',
      date: null,
      inDays: null,
      day: null,
    });
  if (/have the keys/.test(text ?? '')) return call('list_prepared_transfers', {});
  if (/a person/.test(text ?? ''))
    return call('request_human', { summary: 'Keys deposit: please check my prepared transfer' });
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bananabank-e2e-pt-'));
const { DECIDER_API_KEY, ...env } = process.env;
const demo = spawn(process.execPath, ['--import', 'tsx', 'scripts/demo.ts', '--production'], {
  stdio: ['ignore', 'ignore', 'inherit'],
  env: {
    ...env,
    OPENAI_API_KEY: 'test-fake',
    OPENAI_BASE_URL: stubUrl,
    DECIDER: 'none',
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
async function open(persona, tab) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.request.post(`${URL}/api/session`, { data: { userId: persona } });
  await ctx.addInitScript((id) => localStorage.setItem('banana_person', id), persona);
  const page = await ctx.newPage();
  const go = async (t, selector) => {
    await page.goto(`${URL}/?tab=${t}`);
    await page.waitForSelector(selector);
  };
  if (tab) await go(tab, tab === 'transfers' ? '.transfer-form' : '.page-heading');
  const dash = async () => (await ctx.request.get(`${URL}/api/dashboard`)).json();
  // All the customer's accounts: a transfer to another person lowers the sum by its amount.
  const balance = async () => (await dash()).accounts.reduce((s, a) => s + a.balanceCents, 0);
  return { ctx, page, go, dash, balance };
}
const shot = (page, name) =>
  page.screenshot({ path: path.join(SHOTS, `pt4-${name}.png`), fullPage: true });
const cardOf = (page, text) => page.getByTestId('prepared-card').filter({ hasText: text });
const stateOf = (page, text) => cardOf(page, text).getAttribute('data-state');
const proposals = (page) => page.locator('.approvals .proposal');
// Fills the transfer form and saves it as a prepared transfer; `when` picks the choice.
async function prepare(page, amount, concept, when = async () => {}, note = '') {
  await page.locator('select[aria-label="Recipient"]').selectOption({ index: 1 });
  await page.getByLabel('Amount in euros').fill(amount);
  await page.getByPlaceholder('What is this transfer for?').fill(concept);
  await page.getByTestId('prepare-later').click();
  await when();
  if (note) await page.getByTestId('prepare-note').fill(note);
  await page.getByTestId('prepare-save').click();
  await cardOf(page, concept).waitFor();
}
// The app's calendar (plan D9) and its month-end rule: day 31 is the last day of a shorter month.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const [year, month, dayOfMonth] = today.split('-').map(Number);
const occurrence = (monthsAhead, day) => {
  const last = new Date(Date.UTC(year, month + monthsAhead, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 + monthsAhead, Math.min(day, last)))
    .toISOString()
    .slice(0, 10);
};

try {
  // 1. In the page, as Lucía: prepare "when I say" → Send → Confirm. Money moves at Confirm only.
  const lucia = await open('lucia', 'transfers');
  const page = lucia.page;
  const start = await lucia.balance();
  const posts = [];
  page.on('request', (r) => r.method() !== 'GET' && posts.push(`${r.method()} ${r.url()}`));
  await prepare(page, '850', 'Rent October', undefined, 'until I get the keys');
  const ready = cardOf(page, 'Rent October');
  check(
    'prepare: the card is ready, with the note in the customer’s words',
    (await stateOf(page, 'Rent October')) === 'ready' &&
      (await ready.getByTestId('prepared-note').innerText()).includes('until I get the keys'),
    (await ready.innerText()).replace(/\n/g, ' / '),
  );
  check(
    'prepare: saved through /api/prepared, no proposal, balance unchanged',
    posts.some((p) => p.endsWith('POST ' + `${URL}/api/prepared`)) &&
      !posts.some((p) => p.includes('/api/actions')) &&
      (await lucia.dash()).approvals.length === 0 &&
      (await lucia.balance()) === start,
  );
  await shot(page, '1-card-ready');

  await ready.getByTestId('prepared-send').click();
  await proposals(page).first().waitFor();
  await page.locator('[data-testid="prepared-card"][data-state="awaiting_confirmation"]').waitFor();
  check(
    'send: one review card to confirm; the prepared card waits for it and offers no Send',
    (await proposals(page).count()) === 1 &&
      /Waiting for your confirmation above/.test(await ready.innerText()) &&
      (await ready.getByTestId('prepared-send').count()) === 0,
    (await ready.getByTestId('prepared-state').innerText()).trim(),
  );
  check(
    'send: balance still unchanged (Send is not the confirmation)',
    (await lucia.balance()) === start,
  );
  await shot(page, '2-awaiting-confirmation');

  await page.getByRole('button', { name: 'Confirm transfer' }).click();
  await page.locator('.confirm-result').waitFor();
  await ready.waitFor({ state: 'detached' });
  const after = await lucia.balance();
  check(
    'confirm: completed, the card is gone, the balance changed exactly once',
    /completed/i.test(await page.locator('.confirm-result').innerText()) &&
      after === start - 85000 &&
      posts.filter((p) => p.endsWith('/confirm')).length === 1,
    `${start} → ${after}`,
  );
  check(
    'confirm: the transfer is in "Your transfers"',
    (await page.locator('.transfer-history', { hasText: 'Rent October' }).count()) === 1,
  );
  await shot(page, '3-completed');
  await page.getByRole('button', { name: 'Dismiss result' }).click();

  // 2. Due: "On a date" = today → Overview attention row → Review → that card; the bell.
  await prepare(page, '45', 'Gym fee', async () => {
    await page.getByText('On a date', { exact: true }).click();
    await page.getByTestId('prepare-date').fill(today);
  });
  check(
    'on a date, today: due, and still nothing sent',
    (await stateOf(page, 'Gym fee')) === 'due' && (await lucia.balance()) === after,
    (await cardOf(page, 'Gym fee').getByTestId('prepared-state').innerText()).trim(),
  );
  await lucia.go('overview', '.attention-item');
  const row = page.locator('.attention-item', { hasText: 'Prepared transfer due' });
  check(
    'overview: one "Needs your attention" row for the due one',
    (await row.count()) === 1,
    (await row.first().innerText()).replace(/\n/g, ' / '),
  );
  await shot(page, '4-overview-attention');
  await row.getByRole('button', { name: 'Review' }).click();
  await cardOf(page, 'Gym fee').waitFor();
  await page.waitForFunction(() => /Gym fee/.test(document.activeElement?.textContent ?? ''));
  check('overview: Review lands on Transfers with the focus on that card', true);
  await page.getByRole('button', { name: /^Notifications/ }).click();
  const bell = page.locator('.notification-item', { hasText: 'prepared transfer' });
  await bell.first().waitFor();
  const bellText = (await bell.first().innerText()).replace(/\n/g, ' / ');
  check(
    'bell: the due item, saying it is not sent until the customer sends it',
    (await bell.count()) === 1 && /is due\. It is not sent until you send it/.test(bellText),
    bellText,
  );
  await page.keyboard.press('Escape');

  // 3. Monthly. Day 31: the month-end rule; Skip → the month after; Pause → Resume.
  await prepare(page, '30', 'Club dues', async () => {
    await page.getByText('Every month', { exact: true }).click();
    await page.getByTestId('prepare-day').selectOption('31');
  });
  const due = async (concept) => (await lucia.dash()).prepared.find((p) => p.concept === concept);
  const dues = cardOf(page, 'Club dues');
  check(
    'monthly on day 31: next due on the last day of this month',
    (await due('Club dues')).nextDue === occurrence(0, 31),
    `${(await due('Club dues')).nextDue} · ${(await dues.getByTestId('prepared-state').innerText()).trim()}`,
  );
  await dues.getByTestId('prepared-skip').click();
  await page.waitForFunction(() =>
    /Skipped/.test(document.querySelector('.prepared-feedback')?.textContent ?? ''),
  );
  check(
    'skip: the next month’s last day, scheduled',
    (await due('Club dues')).nextDue === occurrence(1, 31) &&
      (await stateOf(page, 'Club dues')) === 'scheduled',
    (await dues.innerText()).replace(/\n/g, ' / '),
  );
  await dues.getByTestId('prepared-pause').click();
  await page.locator('[data-testid="prepared-card"][data-state="paused"]').waitFor();
  check(
    'pause: no Send and no Skip while paused',
    (await dues.getByTestId('prepared-send').count()) +
      (await dues.getByTestId('prepared-skip').count()) ===
      0,
  );
  await dues.getByTestId('prepared-pause').click();
  await page
    .locator('[data-testid="prepared-card"][data-state="paused"]')
    .waitFor({ state: 'detached' });
  check('resume: scheduled again', (await stateOf(page, 'Club dues')) === 'scheduled');
  check(
    'skip, pause and resume moved no money and proposed nothing',
    (await lucia.balance()) === after && (await lucia.dash()).approvals.length === 0,
  );
  // REQ-PT-18: a monthly one due today → Send, Confirm → one transfer, then next month's.
  await prepare(page, '25', 'Parking space', async () => {
    await page.getByText('Every month', { exact: true }).click();
    await page.getByTestId('prepare-day').selectOption(String(dayOfMonth));
  });
  const parking = cardOf(page, 'Parking space');
  check('monthly on today’s day: due', (await stateOf(page, 'Parking space')) === 'due');
  await parking.getByTestId('prepared-send').click();
  await proposals(page).first().waitFor();
  await page.getByRole('button', { name: 'Confirm transfer' }).click();
  await page.locator('.confirm-result').waitFor();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-testid="prepared-card"]')]
        .find((c) => c.textContent.includes('Parking space'))
        ?.getAttribute('data-state') === 'scheduled',
  );
  check(
    'monthly, sent and confirmed: one transfer, the card stays for next month',
    (await lucia.balance()) === after - 2500 &&
      (await due('Parking space')).nextDue === occurrence(1, dayOfMonth),
    `${(await due('Parking space')).nextDue} · ${(await parking.getByTestId('prepared-state').innerText()).trim()}`,
  );
  await lucia.ctx.close();

  // 4. In the chat, as Hugo: prepare → (later) "I have the keys" → the review card → Confirm.
  const hugo = await open('hugo');
  const chat = hugo.page;
  await hugo.go('assistant', 'select[aria-label="Conversation"]');
  const hugoStart = await hugo.balance();
  const answers = () => chat.locator('.message.assistant:not(:has(.thinking))');
  async function tell(text) {
    const before = await answers().count();
    await chat.getByLabel('Message the assistant').fill(text);
    await chat.getByLabel('Message the assistant').press('Enter');
    await chat.waitForFunction(
      (n) =>
        document.querySelectorAll('.message.assistant').length > n &&
        !document.querySelector('.thinking'),
      before,
      { timeout: 60_000 },
    );
  }
  await chat.getByRole('button', { name: '+ New conversation' }).click();
  await tell('Prepare 20 to Lucía for when I get the keys');
  const saved = (await hugo.dash()).prepared;
  const toolResult = JSON.parse(modelRequests.at(-1).input.at(-1).output);
  check(
    'chat, prepare: one prepared transfer with the note; no review card, nothing sent',
    saved.length === 1 &&
      saved[0].note === NOTE &&
      saved[0].state === 'ready' &&
      (await hugo.dash()).approvals.length === 0 &&
      (await chat.locator('.chat-approvals .proposal').count()) === 0 &&
      (await hugo.balance()) === hugoStart,
    `${saved.length} prepared, state ${saved[0]?.state}`,
  );
  check(
    'chat, prepare: the tool result tells the model it is not sent automatically',
    toolResult.status === 'prepared' && /not sent/i.test(toolResult.notice ?? ''),
    toolResult.notice,
  );
  // A second tab, so the conversation stays open in the first one.
  const tab = await hugo.ctx.newPage();
  await tab.goto(`${URL}/?tab=transfers`);
  await cardOf(tab, 'Keys deposit').waitFor();
  check(
    'chat, prepare: the card is in Transfers',
    (await stateOf(tab, 'Keys deposit')) === 'ready' &&
      (await cardOf(tab, 'Keys deposit').innerText()).includes(NOTE),
  );
  await tab.close();
  await tell('I have the keys, send it');
  const card = chat.locator('.chat-approvals .proposal');
  await card.first().waitFor();
  check(
    'chat, "I have the keys": the review card is in the chat; still nothing sent',
    (await card.count()) === 1 &&
      /€20\.00 to Lucía Martín/.test(await card.innerText()) &&
      (await hugo.dash()).prepared[0].state === 'awaiting_confirmation' &&
      (await hugo.balance()) === hugoStart,
    (await card.innerText()).replace(/\n/g, ' / '),
  );
  await card.first().scrollIntoViewIfNeeded();
  await shot(chat, '5-chat-confirmation-card');
  await chat.getByRole('button', { name: 'Confirm transfer' }).click();
  await chat.locator('.confirm-result').waitFor();
  check(
    'chat, confirm: completed once, the prepared transfer is gone',
    /completed/i.test(await chat.locator('.confirm-result').innerText()) &&
      (await hugo.balance()) === hugoStart - 2000 &&
      (await hugo.dash()).prepared.length === 0,
    `${hugoStart} → ${await hugo.balance()}`,
  );
  await tell('Can a person look at this?');
  await hugo.ctx.close();

  // 5. The operator reads the same steps in words, in the case of that conversation.
  const marta = await open('marta', 'overview');
  const searched = marta.page.waitForResponse(
    (r) => /\/api\/incidents\?/.test(r.url()) && r.status() === 200,
  );
  await marta.page.getByLabel('Search cases').fill('Keys deposit');
  await searched;
  await marta.page.locator('.case-list[aria-busy="false"]').waitFor();
  const item = marta.page.locator('.case-item', { hasText: 'Keys deposit' });
  await Promise.all([
    marta.page.waitForResponse((r) => /\/api\/incidents\/[^/]+$/.test(r.url())),
    item.first().click(),
  ]);
  await marta.page.getByText('Customer prepared a transfer').first().waitFor();
  const steps = (await marta.page.locator('.case-rail').innerText()).replace(/\s+/g, ' ');
  check(
    'operator case: prepared, proposed and completed, in words',
    steps.includes(
      `Customer prepared a transfer: €20.00 to Lucía Martín · Aurora account, to send when they decide — note: "${NOTE}". Nothing was sent`,
    ) &&
      // PT4 review: a saved prepare is not "completed", and the proposal names the person.
      steps.includes('Transfer prepared for later: not sent') &&
      !steps.includes('Prepared transfer completed') &&
      steps.includes('Transfer proposed: €20.00 to Lucía Martín · Aurora account') &&
      steps.includes("Prepared transfer proposal: awaiting the customer's confirmation") &&
      steps.includes('Transfer completed by the bank') &&
      steps.includes('Prepared transfer sent by the customer (transfer completed)'),
    steps
      .match(/Customer prepared.*?Nothing was sent|Prepared transfer (proposal:|sent)[^·]*/g)
      ?.join(' | '),
  );
  await shot(marta.page, '6-operator-case');
  await marta.ctx.close();
  check(
    'every model request was answered by the local stub',
    modelRequests.length > 0,
    `${modelRequests.length} requests`,
  );
} catch (e) {
  check('prepared transfers flow', false, `threw: ${e.message.split('\n')[0]}`);
}
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
await stop(failed ? 1 : 0);
