// OP2, OP3, DL1 against a running app. No model calls: cases are opened through POST /api/actions
// (request_human) and the chat message with a citation is stubbed with page.route.
//
// Run (app and bank already running, e.g. `npm run dev`):
//   APP_URL=http://127.0.0.1:3000 node tests/e2e/operator-documents.e2e.mjs
// PLAYWRIGHT_MODULE, PLAYWRIGHT_CHANNEL, SHOTS: README "End-to-end checks".
import { APP_URL as URL, launch, requireSeed, SHOTS } from './env.mjs';
await requireSeed(URL);
const LABEL = process.env.LABEL || 'run';
const browser = await launch();
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const tag = Date.now().toString(36);
async function open(persona) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.request.post(`${URL}/api/session`, { data: { userId: persona } });
  // The page re-selects the person remembered in localStorage (Lucía by default).
  await ctx.addInitScript((id) => localStorage.setItem('banana_person', id), persona);
  const page = await ctx.newPage();
  await page.goto(URL);
  await page.waitForSelector('.page-heading');
  return { ctx, page };
}
const nav = (page, label) => page.locator('nav button', { hasText: label }).first().click();
async function run(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name, false, `threw: ${e.message.split('\n')[0]}`);
  }
}

// A fresh open case for Hugo, used by OP2 (open, no money) and OP3 (resolved by the operator).
const hugo = await open('hugo');
const conv = await (await hugo.ctx.request.post(`${URL}/api/conversations`, { data: {} })).json();
const summary = `OP3 e2e ${tag}: question about card limits`;
await hugo.ctx.request.post(`${URL}/api/actions`, {
  data: { name: 'request_human', arguments: { summary }, conversationId: conv.id },
});

// FX1: a case with money at stake, made here (a rejected transfer attempt, then the case). The
// seeded one (Lucía's transfer recorded failed) stops being one as soon as her dashboard is read.
const bruno = await open('bruno');
const moneyConv = await (
  await bruno.ctx.request.post(`${URL}/api/conversations`, { data: {} })
).json();
for (const [name, args] of [
  [
    'transfer_money',
    { fromAccountId: 'acc-bruno', toAccountId: 'acc-carla', amountCents: 999999900, concept: 'x' },
  ],
  ['request_human', { summary: `Money e2e ${tag}: my transfer was rejected` }],
])
  await bruno.ctx.request.post(`${URL}/api/actions`, {
    data: { name, arguments: args, conversationId: moneyConv.id },
  });
await bruno.ctx.close();

await run('OP2', async () => {
  const { ctx, page } = await open('marta');
  await page.locator('.case-item').first().waitFor();
  const items = await page.locator('.case-item').evaluateAll((els) =>
    els.map((el) => ({
      priority: el.querySelector('.case-priority')?.className.split(' ')[1] ?? 'closed',
      reason: el.querySelector('.case-priority')?.textContent ?? '',
      status: el.querySelector('small')?.textContent ?? '',
    })),
  );
  check(
    'OP2 first case has money at stake and says why',
    items[0]?.priority === 'money' && /Money at stake/.test(items[0].reason),
    JSON.stringify(items[0]),
  );
  const ranks = items.map((i) => ['money', 'open', 'closed'].indexOf(i.priority));
  check(
    'OP2 money, then open, then resolved',
    ranks.includes(1) && ranks.every((r, i) => r >= 0 && (i === 0 || ranks[i - 1] <= r)),
    ranks.join(''),
  );
  check(
    'OP2 open cases say how long they have waited',
    items.some((i) => i.priority === 'open') &&
      // S4: the reason has no time; the wait starts at the case date shown in local time.
      items
        .filter((i) => i.priority === 'open')
        .every((i) => i.reason === 'Waiting for support' && /\d{2}:\d{2} · Open$/.test(i.status)),
  );
  await page.screenshot({ path: `${SHOTS}/op2-inbox-${LABEL}.png` });
  await ctx.close();
});

await run('OP3', async () => {
  const { ctx, page } = await open('marta');
  await Promise.all([
    page.waitForResponse((r) => /\/api\/incidents\/[^/]+$/.test(r.url())),
    page.locator('.case-item', { hasText: summary }).click(),
  ]);
  // S6: the first click only asks; "Yes, mark resolved" resolves.
  await page.getByRole('button', { name: 'Mark resolved' }).click();
  check(
    'S6 first click asks for confirmation, case still open',
    (await page.getByText('Are you sure?').count()) === 1 &&
      (await page.locator('.case-detail .status-pill').innerText()) === 'Open',
  );
  await page.getByRole('button', { name: 'Yes, mark resolved' }).click();
  await page.locator('.case-detail .status-pill', { hasText: 'Resolved' }).waitFor();
  await ctx.close();
  await hugo.page.reload();
  await nav(hugo.page, 'Assistant');
  await hugo.page.getByLabel('Conversation', { exact: true }).selectOption(conv.id);
  const note = hugo.page.locator('.message.assistant', { hasText: 'A support agent marked' });
  await note.waitFor({ timeout: 8000 }).catch(() => {});
  const text = (await note.count()) ? await note.innerText() : '';
  check(
    'OP3 customer sees the dated resolution note',
    // S4: the note has no time of its own; the message timestamp is local time, no "UTC".
    /A support agent marked your request as resolved\./.test(text) &&
      /\d{2}:\d{2}/.test(text) &&
      !/UTC/.test(text),
    text || 'no note',
  );
  await hugo.page.screenshot({ path: `${SHOTS}/op3-customer-note-${LABEL}.png` });
});
await hugo.ctx.close();

await run('DL1 filters', async () => {
  const { ctx, page } = await open('lucia');
  await nav(page, 'Documents');
  await page.waitForSelector('.document-list button');
  const titles = () => page.locator('.document-list button strong').allInnerTexts();
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/documents?') && r.url().includes('aurora')),
    page.getByLabel('Filter by product').selectOption('aurora'),
  ]);
  const aurora = await titles();
  check(
    'DL1 product filter lists only Aurora documents',
    aurora.length > 3 && aurora.every((t) => /Aurora/.test(t)),
    `${aurora.length}`,
  );
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('validity=archived')),
    page.getByLabel('Filter by validity').selectOption('archived'),
  ]);
  const archived = await titles();
  check(
    'DL1 validity filter lists only archived Aurora documents',
    archived.length > 0 && archived.every((t) => /Aurora · archived/.test(t)),
    archived.join(' | '),
  );
  await page.screenshot({ path: `${SHOTS}/dl1-filters-${LABEL}.png` });
  await ctx.close();
});

await run('DL1 highlight', async () => {
  const { ctx, page } = await open('lucia');
  const chunks = await (
    await ctx.request.get(`${URL}/api/documents/aurora-fees-2026/chunks`)
  ).json();
  const chunk = chunks.at(-1);
  const c = await (await ctx.request.post(`${URL}/api/conversations`, { data: {} })).json();
  const now = new Date().toISOString();
  const source = {
    documentId: 'aurora-fees-2026',
    title: 'Aurora · current fees',
    version: 2,
    validFrom: '2026-09-01',
    validTo: null,
  };
  await page.route(`**/api/conversations/${c.id}`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        conversation: { id: c.id },
        messages: [
          { id: 'u1', role: 'user', content: 'Aurora fees?', created_at: now, sources: [] },
          {
            id: 'a1',
            role: 'assistant',
            content: 'Here is what the fee schedule says.',
            created_at: now,
            sources: [{ ...source, id: chunk.id }],
          },
          {
            id: 'a2',
            role: 'assistant',
            content: 'An older answer, stored before chunk ids.',
            created_at: now,
            sources: [source],
          },
        ],
      }),
    }),
  );
  await page.reload();
  await nav(page, 'Assistant');
  await page.getByLabel('Conversation', { exact: true }).selectOption(c.id);
  const cite = (id) =>
    page.locator(`.message.assistant:has-text("${id}") .citations button`).first();
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/chunks')),
    cite('fee schedule says').click(),
  ]);
  const mark = page.locator('.document-reader mark.cited-excerpt');
  await mark.waitFor({ timeout: 8000 }).catch(() => {});
  const marked = (await mark.count()) ? await mark.innerText() : '';
  const body = chunk.text.split('\n\n').slice(1).join('\n\n');
  check(
    'DL1 citation highlights the cited chunk in the document',
    marked.length > 20 && marked.replace(/\s+/g, ' ') === body.replace(/\s+/g, ' '),
    marked.slice(0, 80) || 'no mark',
  );
  const visible = await page.evaluate(() => {
    const m = document.querySelector('.document-reader mark');
    const r = document.querySelector('.document-reader');
    if (!m || !r) return false;
    const a = m.getBoundingClientRect(),
      b = r.getBoundingClientRect();
    return a.top < b.bottom && a.bottom > b.top;
  });
  check('DL1 highlighted excerpt is scrolled into the reader', visible);
  await page.screenshot({ path: `${SHOTS}/dl1-highlight-${LABEL}.png` });
  await nav(page, 'Assistant');
  await page.getByLabel('Conversation', { exact: true }).selectOption(c.id);
  await cite('older answer').click();
  await page.locator('.document-reader h2', { hasText: 'Aurora · current fees' }).waitFor();
  check('DL1 a citation without chunk id opens the document unmarked', (await mark.count()) === 0);
  await ctx.close();
});

await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
