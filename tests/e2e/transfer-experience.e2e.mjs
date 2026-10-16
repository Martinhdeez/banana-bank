// Behaviour checks for X1–X5 and D4 (send refresh errors) against a running app. No model calls:
// proposals are created through POST /api/actions and the chat is stubbed with page.route.
// The bank scenario is set to "normal" for the run and restored to "intermittent 17" after.
//
// Run (app and bank already running, e.g. `npm run dev`):
//   APP_URL=http://127.0.0.1:3000 BANK_URL=http://127.0.0.1:4001 node tests/e2e/transfer-experience.e2e.mjs
// Playwright setup and overrides (PLAYWRIGHT_MODULE, PLAYWRIGHT_CHANNEL): README "End-to-end checks".
// SHOTS sets the screenshot folder.
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
// A scenario call that fails must stop the run, not leave the bank on `intermittent`.
const scenario = async (profile, seed = 17) => {
  const r = await fetch(`${BANK}/admin/scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ profile, seed }),
  });
  if (!r.ok)
    throw new Error(
      `bank scenario ${profile}: HTTP ${r.status} (check BANK_URL and BANK_ADMIN_SECRET)`,
    );
};
const tag = Date.now().toString(36);
// Rerunnable without `npm run reset`: amounts unique to this run (X3 flags by from|to|amount, so a
// leftover proposal from an earlier run with the same amount would be flagged too), and every
// proposal carrying this run's tag is cancelled at the end (sweep).
const cents = 1000 + (Date.now() % 4000) * 2;
async function sweep(persona = 'lucia') {
  const ctx = await browser.newContext();
  await ctx.request.post(`${URL}/api/session`, { data: { userId: persona } });
  const { approvals = [] } = await (await ctx.request.get(`${URL}/api/dashboard`)).json();
  for (const a of approvals.filter((a) => a.payload?.concept?.includes(tag)))
    await ctx.request.post(`${URL}/api/approvals/${a.id}/cancel`, { data: {} });
  await ctx.close();
}

async function open(persona = 'lucia') {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.request.post(`${URL}/api/session`, { data: { userId: persona } });
  const page = await ctx.newPage();
  await page.goto(URL);
  await page.waitForSelector('.page-heading');
  return { ctx, page };
}
async function propose(ctx, concept, extra = {}, amountCents = 125) {
  const r = await ctx.request.post(`${URL}/api/actions`, {
    data: {
      name: 'transfer_money',
      arguments: { fromAccountId: 'acc-lucia', toAccountId: 'acc-carla', amountCents, concept },
      intentId: `e2e-${tag}-${Math.random().toString(36).slice(2)}`,
      ...extra,
    },
  });
  const body = await r.json();
  if (body.status !== 'requires_confirmation') throw new Error(JSON.stringify(body));
  return body;
}
const row = (page, concept) => page.locator('.approvals > div', { hasText: concept });
const nav = (page, label) => page.locator('nav button', { hasText: label }).click();

async function run(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name, false, `threw: ${e.message.split('\n')[0]}`);
  }
}

await scenario('normal');

// X1: the confirm result appears inside the proposals panel, focused and in view.
await run('X1', async () => {
  const { ctx, page } = await open();
  const concept = `X1 ${tag}`;
  await propose(ctx, concept);
  await page.reload();
  await nav(page, 'Transfers');
  await row(page, concept)
    .getByRole('button', { name: /Confirm/ })
    .click();
  const result = page.locator('.approvals .confirm-result');
  await result.waitFor({ timeout: 8000 });
  const text = await result.innerText();
  const focused = await page.evaluate(
    () => !!document.activeElement?.closest('.approvals .confirm-result'),
  );
  const box = await result.boundingBox();
  const inView = !!box && box.y >= 0 && box.y + box.height <= 900;
  check('X1 result shown inside the proposals panel', /Transfer completed/.test(text), text);
  check(
    'X1 result focused and in the viewport',
    focused && inView,
    `focused=${focused} inView=${inView}`,
  );
  check('X1 no duplicate top banner', (await page.locator('main > .alert.notice').count()) === 0);
  await page.screenshot({ path: `${SHOTS}/x1-after-confirm-${LABEL}.png` });
  await ctx.close();
});

// X2 / R6: the confirmed outcome is a message the server stores in the proposal's conversation,
// so it is shown after confirming, after a reload and in another browser (no localStorage).
await run('X2', async () => {
  const { ctx, page } = await open();
  const conv = await (await ctx.request.post(`${URL}/api/conversations`, { data: {} })).json();
  const concept = `X2 ${tag}`;
  await ctx.request.post(`${URL}/api/actions`, {
    data: {
      name: 'transfer_money',
      arguments: {
        fromAccountId: 'acc-lucia',
        toAccountId: 'acc-carla',
        amountCents: 125,
        concept,
      },
      intentId: `x2-${tag}`,
      conversationId: conv.id,
    },
  });
  const openChat = async (p) => {
    await p.reload();
    await nav(p, 'Assistant');
    await p.getByLabel('Conversation', { exact: true }).selectOption(conv.id);
  };
  await openChat(page);
  await row(page, concept)
    .getByRole('button', { name: /Confirm/ })
    .click();
  const line = (p) => p.locator('.message .outcome', { hasText: concept });
  await line(page)
    .waitFor({ timeout: 8000 })
    .catch(() => {});
  const text = (await line(page).count()) ? await line(page).innerText() : '';
  check('X2 chat shows the confirmed outcome', /Transfer completed/.test(text), text || 'no line');
  await page.screenshot({ path: `${SHOTS}/x2-chat-after-confirm-${LABEL}.png` });
  const other = await open();
  await openChat(other.page);
  await line(other.page)
    .waitFor({ timeout: 8000 })
    .catch(() => {});
  const again = (await line(other.page).count()) ? await line(other.page).innerText() : '';
  check(
    'X2 outcome shown in another browser',
    /Transfer completed/.test(again),
    again || 'no line',
  );
  await other.ctx.close();
  await ctx.close();
});

// X3: identical pending proposals are flagged.
await run('X3', async () => {
  const { ctx, page } = await open();
  const concept = `X3 ${tag}`;
  await propose(ctx, concept, {}, cents);
  await propose(ctx, concept, {}, cents);
  await propose(ctx, `X3 other ${tag}`, {}, cents + 1);
  await page.reload();
  await nav(page, 'Transfers');
  await row(page, concept).first().waitFor();
  const flagged = await row(page, concept).locator('.duplicate-flag').count();
  const other = await row(page, `X3 other ${tag}`).locator('.duplicate-flag').count();
  check('X3 both identical proposals flagged', flagged === 2, `flagged=${flagged}`);
  check('X3 a different proposal not flagged', other === 0, `other=${other}`);
  await row(page, concept).first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/x3-identical-${LABEL}.png` });
  await ctx.close();
});

// X4: form options show names, not ids; the form is cleared once a proposal exists.
await run('X4', async () => {
  const { ctx, page } = await open();
  await nav(page, 'Transfers');
  const options = await page.locator('.transfer-form option').allInnerTexts();
  check(
    'X4 no account ids in form options',
    !options.some((o) => /acc-/.test(o)),
    options.join(' | '),
  );
  const form = page.locator('.transfer-form');
  await form.getByLabel('Recipient', { exact: true }).selectOption('carla');
  await page.getByLabel('Amount in euros').fill('1.10');
  await form.getByPlaceholder('What is this transfer for?').fill(`X4 ${tag}`);
  await form.getByRole('button', { name: /Review transfer/ }).click();
  await row(page, `X4 ${tag}`).waitFor({ timeout: 8000 });
  const values = [
    await form.getByLabel('Recipient', { exact: true }).inputValue(),
    await page.getByLabel('Amount in euros').inputValue(),
    await form.getByPlaceholder('What is this transfer for?').inputValue(),
  ];
  check(
    'X4 form cleared after the proposal',
    values.every((v) => v === ''),
    JSON.stringify(values),
  );
  await page.screenshot({ path: `${SHOTS}/x4-form-after-proposal-${LABEL}.png` });
  await ctx.close();
});

// X5: the overview chip shows the real date with a clear label, in the shared format.
await run('X5', async () => {
  const { ctx, page } = await open();
  const today = new Intl.DateTimeFormat('en-IE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date());
  const chip = (await page.locator('.date-chip').innerText()).trim();
  check('X5 chip is labelled and shows today', chip === `Today · ${today}`, chip);
  const movement = (await page.locator('.movement small').first().innerText()).trim();
  check('X5 movement dates include the year', /\b20\d\d\b/.test(movement), movement);
  await page.screenshot({ path: `${SHOTS}/x5-overview-${LABEL}.png` });
  await ctx.close();
});

// D4: a failed reload after sending a message is reported, not swallowed.
await run('D4', async () => {
  const { ctx, page } = await open();
  await page.route('**/api/conversations/*/messages', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/conversations/*', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: '{"error":"Reload failed."}',
        })
      : route.fallback(),
  );
  await nav(page, 'Assistant');
  await page.getByLabel('Message the assistant').fill('hello');
  await page.getByLabel('Message the assistant').press('Enter');
  const alert = page.locator('.alert.error');
  await alert.waitFor({ timeout: 5000 }).catch(() => {});
  const text = (await alert.count()) ? await alert.innerText() : '';
  check('D4 refresh error after send is shown', /Reload failed/.test(text), text || 'no error');
  await ctx.close();
});

try {
  await sweep();
} finally {
  // Restore the default scenario even if the sweep throws.
  await scenario('intermittent', 17);
  await browser.close();
}
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
