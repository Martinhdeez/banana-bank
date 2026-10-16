// Behaviour checks for U1, U2, U4, U5, U7 against a running app. No model or embeddings calls:
// chat messages, search, ingestion and the failing GETs are stubbed with page.route.
// Run: APP_URL=http://127.0.0.1:3400 LABEL=after node tests/e2e/frontend-defects.e2e.mjs
// D3: Playwright is not a dependency; see README "End-to-end checks". PLAYWRIGHT_MODULE points to
// another playwright/index.mjs, PLAYWRIGHT_CHANNEL=chrome uses an installed Chrome, SHOTS another
// screenshot folder.
import { APP_URL as URL, launch, requireSeed, SHOTS } from './env.mjs';
await requireSeed(URL);
const LABEL = process.env.LABEL || 'run';
const browser = await launch();
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const gate = () => {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const stub = (page, pattern, g, status, body) =>
  page.route(pattern, async (route) => {
    await g.p;
    await route
      .fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      .catch(() => {});
  });

async function switchTo(page, id) {
  await page.waitForFunction(
    () => !document.querySelector('select[aria-label="Switch person"]')?.disabled,
  );
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/dashboard')),
    page.getByLabel('Switch person').selectOption(id),
  ]);
  await page.waitForSelector('.page-heading');
  await pause(300);
}
async function open(persona) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);
  await switchTo(page, persona);
  return { ctx, page, errors };
}
const nav = (page, label) => page.locator('nav button', { hasText: label }).click();
const chatStub = (page, g) => stub(page, '**/api/conversations/*/messages', g, 200, {});

async function scenario(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name, false, `threw: ${e.message.split('\n')[0]}`);
  }
}

// U1a: a running search must not show "Checking…" in the chat nor "Processing…" on transfers.
await scenario('U1a', async () => {
  const { ctx, page } = await open('lucia');
  const g = gate();
  await stub(page, '**/api/search', g, 200, { sources: [] });
  await nav(page, 'Documents');
  await page.getByLabel('Search documents').fill('account fee');
  await page.locator('.search-form button').click();
  await nav(page, 'Transfers');
  const label = (await page.locator('.transfer-form button.primary-button').innerText()).trim();
  check('U1a transfer button unaffected by a running search', label === 'Review transfer', label);
  await nav(page, 'Assistant');
  const thinking = await page.locator('.thinking').count();
  check('U1a chat shows no "Checking…" during a search', thinking === 0, `thinking=${thinking}`);
  g.open();
  await ctx.close();
});

// U1b: a running chat turn must not block search or the transfer button.
await scenario('U1b', async () => {
  const { ctx, page } = await open('lucia');
  const g = gate();
  await chatStub(page, g);
  await nav(page, 'Assistant');
  await page.getByLabel('Message the assistant').fill('hello');
  await page.getByLabel('Message the assistant').press('Enter');
  await page.waitForSelector('.thinking');
  await nav(page, 'Transfers');
  const label = (await page.locator('.transfer-form button.primary-button').innerText()).trim();
  check('U1b transfer button unaffected by a chat turn', label === 'Review transfer', label);
  await page.screenshot({ path: `${SHOTS}/u1-transfer-during-chat-${LABEL}.png` });
  await nav(page, 'Documents');
  await page.getByLabel('Search documents').fill('account fee');
  const disabled = await page.locator('.search-form button').isDisabled();
  check('U1b search enabled during a chat turn', !disabled, `disabled=${disabled}`);
  await nav(page, 'Assistant');
  check('U1b chat still "Checking…"', (await page.locator('.thinking').count()) === 1);
  g.open();
  await ctx.close();
});

// U1c + U4: an ingestion started as an operator ends after switching to a customer who is
// mid chat turn: it must not end the customer's busy state nor show its notice.
await scenario('U1c', async () => {
  const { ctx, page } = await open('marta');
  const ingest = gate(),
    chat = gate();
  await stub(page, '**/api/ingestion', ingest, 200, { documents: 3, chunks: 9 });
  await chatStub(page, chat);
  await nav(page, 'Documents');
  await page.getByRole('button', { name: /Update index/ }).click();
  await switchTo(page, 'lucia');
  await nav(page, 'Assistant');
  await page.getByLabel('Message the assistant').fill('hello');
  await page.getByLabel('Message the assistant').press('Enter');
  await page.waitForSelector('.thinking');
  ingest.open();
  await pause(1000);
  const thinking = await page.locator('.thinking').count();
  check('U1c chat turn keeps "Checking…" after another action ends', thinking === 1);
  await page.getByLabel('Message the assistant').fill('second');
  const sendDisabled = await page.getByLabel('Send message').isDisabled();
  check('U1c Send stays disabled during the chat turn', sendDisabled);
  const notice = await page.locator('.alert.notice', { hasText: 'Index updated' }).count();
  check('U1c operator ingestion notice not shown to the customer', notice === 0);
  chat.open();
  await ctx.close();
});

// U2: choosing "New conversation" in the picker must not crash.
await scenario('U2', async () => {
  const { ctx, page, errors } = await open('lucia');
  await nav(page, 'Assistant');
  const picker = page.getByLabel('Conversation', { exact: true });
  const options = await picker.locator('option').count();
  if (options > 1) {
    await picker.selectOption({ index: 1 });
    await pause(800);
  }
  await picker.selectOption('');
  await pause(1200);
  await page.screenshot({ path: `${SHOTS}/u2-new-conversation-${LABEL}.png` });
  const empty = await page.locator('.chat-empty').count();
  check(
    'U2 picker "New conversation" shows an empty chat without errors',
    errors.length === 0 && empty === 1,
    errors[0] || `empty=${empty}`,
  );
  await ctx.close();
});

// U4a: a case error from the operator must not appear on the next persona.
await scenario('U4a', async () => {
  const { ctx, page } = await open('marta');
  const g = gate();
  await stub(page, '**/api/incidents/*', g, 500, { error: 'Case failed (stub)' });
  await page.locator('.case-item').first().click();
  await switchTo(page, 'lucia');
  g.open();
  await pause(800);
  const alerts = await page.locator('.alert.error', { hasText: 'stub' }).count();
  check('U4a case error not shown on the next persona', alerts === 0);
  await ctx.close();
});

// U4b: a document error must not appear on the next persona.
await scenario('U4b', async () => {
  const { ctx, page } = await open('lucia');
  const g = gate();
  await stub(page, '**/api/documents/*', g, 500, { error: 'Document failed (stub)' });
  await nav(page, 'Documents');
  await page.locator('.document-list button').first().click();
  await switchTo(page, 'diego');
  g.open();
  await pause(800);
  const alerts = await page.locator('.alert.error', { hasText: 'stub' }).count();
  check('U4b document error not shown on the next persona', alerts === 0);
  await ctx.close();
});

// U5a: the document list reloads after ingestion.
await scenario('U5a', async () => {
  const { ctx, page } = await open('marta');
  const g = gate();
  g.open();
  await stub(page, '**/api/ingestion', g, 200, { documents: 3, chunks: 9 });
  await nav(page, 'Documents');
  await pause(500);
  let reloads = 0;
  page.on('request', (r) => {
    if (r.method() === 'GET' && r.url().endsWith('/api/documents')) reloads++;
  });
  await page.getByRole('button', { name: /Update index/ }).click();
  await pause(1500);
  check('U5a documents reloaded after ingestion', reloads >= 1, `reloads=${reloads}`);
  await ctx.close();
});

// U5b: "+ New conversation" does not create empty conversations.
await scenario('U5b', async () => {
  const { ctx, page } = await open('lucia');
  let posts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/conversations')) posts++;
  });
  const before = await page.locator('.conversation-list button').count();
  await page.locator('.history-heading button').click();
  await pause(300);
  await page.getByRole('button', { name: '+ New conversation' }).click();
  await pause(800);
  const after = await page.locator('.conversation-list button').count();
  check(
    'U5b new conversation creates nothing until the first message',
    posts === 0 && after === before,
    `posts=${posts} rows ${before}->${after}`,
  );
  await ctx.close();
});

// U7: accessibility basics.
await scenario('U7', async () => {
  const { ctx, page } = await open('lucia');
  const current = await page.locator('nav button[aria-current="page"]').allInnerTexts();
  check('U7 active nav item has aria-current', current.join().includes('Overview'), current.join());
  // R4: rows now say "Received from X" / "Sent to Y" / "Between your accounts" in visible text;
  // rows titled with the bank's description keep the screen-reader prefix.
  const texts = await page.locator('.movement').allInnerTexts();
  const direction = texts.filter((t) =>
    /Received|Sent|Between your accounts|Pending your confirmation|Being verified/.test(t),
  ).length;
  const hidden = await page.locator('.movement .sr-only').count();
  check(
    'U7 movement direction exposed as text',
    texts.length > 0 && direction + hidden >= texts.length,
    `rows=${texts.length} visible=${direction} labels=${hidden}`,
  );
  await nav(page, 'Assistant');
  const live = await page.locator('.messages[aria-live="polite"]').count();
  check('U7 chat log is a live region', live === 1);
  await ctx.close();
});

await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed (${LABEL})`);
process.exit(failed ? 1 : 0);
