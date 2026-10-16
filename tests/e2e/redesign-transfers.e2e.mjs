// Redesign slice 3 (Transfers): U3 strict amount/concept, U8 newest proposal first, U9 wording,
// the "Estimated, if confirmed" summary, recipient chips, and live-demo finding C (DV7: a confirm
// while the bank cannot be read removes the proposal and still reloads the chat). No model calls.
// The bank scenario is set to "normal" for the run and restored to "intermittent 17" after.
//
// Run (app and bank already running):
//   APP_URL=http://127.0.0.1:3000 BANK_URL=http://127.0.0.1:4001 node tests/e2e/redesign-transfers.e2e.mjs
// PLAYWRIGHT_MODULE, PLAYWRIGHT_CHANNEL: README "End-to-end checks". SHOTS: screenshot folder.
import { APP_URL as URL, launch, SHOTS, requireBankUrl } from './env.mjs';
const BANK = requireBankUrl();
const ADMIN = process.env.BANK_ADMIN_SECRET || 'banana-local-admin';
const LABEL = process.env.LABEL || 'run';
const browser = await launch();
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const scenario = (profile, seed = 17) =>
  fetch(`${BANK}/admin/scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ profile, seed }),
  });
const tag = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (cents) =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100);

async function open(persona = 'lucia') {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.request.post(`${URL}/api/session`, { data: { userId: persona } });
  const page = await ctx.newPage();
  await page.addInitScript((p) => localStorage.setItem('banana_person', p), persona);
  await page.goto(`${URL}/?tab=transfers`);
  await page.waitForSelector('.transfer-form');
  return { ctx, page };
}
async function propose(ctx, concept, conversationId) {
  const r = await ctx.request.post(`${URL}/api/actions`, {
    data: {
      name: 'transfer_money',
      arguments: {
        fromAccountId: 'acc-lucia',
        toAccountId: 'acc-carla',
        amountCents: 125,
        concept,
      },
      intentId: `rt-${tag}-${Math.random().toString(36).slice(2)}`,
      ...(conversationId && { conversationId }),
    },
  });
  const body = await r.json();
  if (body.status !== 'requires_confirmation') throw new Error(JSON.stringify(body));
  return body;
}
const actionPosts = (page) => {
  const seen = [];
  page.on(
    'request',
    (r) => r.method() === 'POST' && r.url().endsWith('/api/actions') && seen.push(r),
  );
  return seen;
};
async function run(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name, false, `threw: ${e.message.split('\n')[0]}`);
  }
}

await scenario('normal');

// U3: "12,50" is accepted; "1e3" and a blank concept are refused before any request.
await run('U3', async () => {
  const { ctx, page } = await open();
  const form = page.locator('.transfer-form');
  const amount = page.getByLabel('Amount in euros');
  const concept = form.getByPlaceholder('What is this transfer for?');
  const posts = actionPosts(page);
  await form.getByLabel('Recipient', { exact: true }).selectOption('carla');
  await amount.fill('1e3');
  await concept.fill(`U3 ${tag}`);
  await form.getByRole('button', { name: /Review transfer/ }).click();
  await sleep(500);
  const expInvalid = await amount.evaluate((el) => el.matches(':invalid'));
  check(
    'U3 "1e3" is invalid and sends nothing',
    expInvalid && posts.length === 0,
    `invalid=${expInvalid} posts=${posts.length}`,
  );
  await amount.fill('12,50');
  await concept.fill('   ');
  await form.getByRole('button', { name: /Review transfer/ }).click();
  await sleep(500);
  const blankInvalid = await concept.evaluate((el) => el.matches(':invalid'));
  check(
    'U3 a blank concept is invalid and sends nothing',
    blankInvalid && posts.length === 0,
    `invalid=${blankInvalid} posts=${posts.length}`,
  );
  await concept.fill(`U3 ${tag}`);
  await form.getByRole('button', { name: /Review transfer/ }).click();
  const proposal = page.locator('.approvals .proposal', { hasText: `U3 ${tag}` });
  await proposal.waitFor({ timeout: 8000 });
  const text = await proposal.innerText();
  check('U3 "12,50" makes a €12.50 proposal', text.includes(money(1250)), text.split('\n')[1]);
  await ctx.close();
});

// U8 + U9: newest proposal first; one vocabulary.
await run('U8/U9', async () => {
  const { ctx, page } = await open();
  await propose(ctx, `U8 first ${tag}`);
  await sleep(1100);
  await propose(ctx, `U8 second ${tag}`);
  await page.reload();
  await page.waitForSelector('.approvals .proposal');
  const first = await page.locator('.approvals .proposal').first().innerText();
  check(
    'U8 the newest proposal comes first',
    first.includes(`U8 second ${tag}`),
    first.split('\n')[1],
  );
  const row = page.locator('.approvals > div', { hasText: `U8 first ${tag}` });
  const buttons = await row.getByRole('button').allInnerTexts();
  check(
    'U9 buttons read "Confirm transfer" and "Cancel"',
    buttons.join('|') === 'Confirm transfer|Cancel',
    buttons.join('|'),
  );
  const body = await page.locator('main').innerText();
  check(
    'U9 no old wording',
    !/Cancel proposal|Proposals awaiting|in this environment/.test(body) &&
      /Transfers to confirm/.test(body),
  );
  await page.screenshot({ path: `${SHOTS}/u8-u9-panel-${LABEL}.png` });
  await ctx.close();
});

// Summary estimate and recipient chips.
await run('Estimate/Chips', async () => {
  const { ctx, page } = await open();
  const form = page.locator('.transfer-form');
  // CF8: once paid (another suite pays Carla), the chip's name ends with its "Paid {date}" line.
  await form.getByRole('button', { name: /^Carla( Paid |$)/ }).click();
  const value = await form.getByLabel('Recipient', { exact: true }).inputValue();
  const pressed = await form
    .getByRole('button', { name: /^Carla( Paid |$)/ })
    .getAttribute('aria-pressed');
  check(
    'Chips a chip selects the person',
    value === 'carla' && pressed === 'true',
    `value=${value} pressed=${pressed}`,
  );
  await page.getByLabel('Amount in euros').fill('1.10');
  const from = await form.locator('input[name=from]:checked').inputValue();
  const dash = await page.evaluate(async () => (await fetch('/api/dashboard')).json());
  const balance = dash.accounts.find((a) => a.id === from).balanceCents;
  const label = await form.locator('.summary-rows dt').nth(3).innerText();
  const estimate = await form.locator('.summary-rows .estimate span').innerText();
  const note = await form.locator('.summary-rows .estimate small').innerText();
  check(
    'Estimate "Balance after" is balance minus amount, noted "Estimated, if confirmed"',
    label === 'Balance after' &&
      estimate === money(balance - 110) &&
      note === 'Estimated, if confirmed',
    `${label}: ${estimate} (${note}; expected ${money(balance - 110)})`,
  );
  await ctx.close();
});

// Finding C (DV7): confirm while the bank cannot be read. The proposal leaves the panel, the
// dashboard error is shown, and the chat is still reloaded with the stored outcome line.
await run('C', async () => {
  const { ctx, page } = await open();
  const conv = await (await ctx.request.post(`${URL}/api/conversations`, { data: {} })).json();
  const concept = `C ${tag}`;
  await propose(ctx, concept, conv.id);
  await page.goto(`${URL}/?tab=assistant`);
  await page.getByLabel('Conversation', { exact: true }).selectOption(conv.id);
  const proposal = page.locator('.approvals .proposal', { hasText: concept });
  await proposal.waitFor({ timeout: 8000 });
  // The bank takes the transfer but its answer is lost (outcome unknown, pending verification),
  // and the dashboard read that follows fails as it does while the bank is unreachable.
  await scenario('read-unavailable');
  await page.route('**/api/dashboard', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":"The bank is not answering."}',
    }),
  );
  await proposal.getByRole('button', { name: /Confirm/ }).click();
  const result = page.locator('.approvals .confirm-result');
  await result.waitFor({ timeout: 15000 });
  console.log(`   outcome: ${(await result.innerText()).replace(/\s+/g, ' ')}`);
  await proposal.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
  check('C the consumed proposal leaves the panel', (await proposal.count()) === 0);
  const line = page.locator('.message .outcome', { hasText: concept });
  await line.waitFor({ timeout: 8000 }).catch(() => {});
  check('C the chat outcome is shown despite the failed refresh', (await line.count()) > 0);
  const alert = page.locator('.alert.error');
  await alert
    .first()
    .waitFor({ timeout: 3000 })
    .catch(() => {});
  const error = (await alert.count()) ? await alert.first().innerText() : '';
  check('C the refresh failure is reported', !!error, error.split('\n')[0] || 'no error');
  await page.screenshot({ path: `${SHOTS}/c-bank-unreadable-${LABEL}.png` });
  await scenario('normal');
  await ctx.close();
});

// Rerunnable without a reset: cancel this run's proposals that are still pending (tag in concept).
const cleanup = await browser.newContext();
await cleanup.request.post(`${URL}/api/session`, { data: { userId: 'lucia' } });
const left = (await (await cleanup.request.get(`${URL}/api/dashboard`)).json()).approvals ?? [];
for (const a of left.filter((a) => a.payload.concept.includes(tag)))
  await cleanup.request.post(`${URL}/api/approvals/${a.id}/cancel`, { data: {} });
await cleanup.close();
await scenario('intermittent', 17);
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
