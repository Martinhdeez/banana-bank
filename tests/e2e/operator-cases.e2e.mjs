// Redesigned operator Cases view (U4, U10 operator side) against a running app. No model calls:
// the case is opened through POST /api/actions (request_human).
//
// Run (app and bank already running):
//   APP_URL=http://127.0.0.1:3000 DATA_DIR=<its data dir> node tests/e2e/operator-cases.e2e.mjs
// PLAYWRIGHT_MODULE / PLAYWRIGHT_CHANNEL as in the other e2e scripts; SHOTS sets the screenshot folder.
import { APP_URL as URL, launch, SHOTS, requireDataDir, requireSeed } from './env.mjs';
// The Audit block edits one event in the running app's database (and restores it).
const DATA_DIR = requireDataDir();
await requireSeed(URL);
const browser = await launch();
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const tag = Date.now().toString(36);
async function open(persona, width = 1440, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.request.post(`${URL}/api/session`, { data: { userId: persona } });
  await ctx.addInitScript((id) => localStorage.setItem('banana_person', id), persona);
  const page = await ctx.newPage();
  await page.goto(URL);
  await page.waitForSelector('.page-heading');
  return { ctx, page };
}
async function run(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name, false, `threw: ${e.message.split('\n')[0]}`);
  }
}
const statuses = (page) =>
  page.locator('.case-item').evaluateAll((els) =>
    els.map((el) => ({
      priority: !!el.querySelector('.case-priority'),
      status: el.querySelector('small')?.textContent ?? '',
    })),
  );
const openCase = (page, locator) =>
  Promise.all([
    page.waitForResponse((r) => /\/api\/incidents\/[^/]+$/.test(r.url())),
    locator.click(),
  ]);

// A fresh open case for Hugo.
const hugo = await open('hugo');
const conv = await (await hugo.ctx.request.post(`${URL}/api/conversations`, { data: {} })).json();
const summary = `Cases e2e ${tag}: question about card limits`;
await hugo.ctx.request.post(`${URL}/api/actions`, {
  data: { name: 'request_human', arguments: { summary }, conversationId: conv.id },
});
await hugo.ctx.close();
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

await run('Views', async () => {
  const { ctx, page } = await open('marta');
  await page.locator('.case-item').first().waitFor();
  const { incidents } = await (await ctx.request.get(`${URL}/api/dashboard`)).json();
  const nOpen = incidents.filter((c) => c.status === 'open').length;
  const nClosed = incidents.filter((c) => c.status === 'closed').length;
  const openTab = page.getByRole('button', { name: `Open · ${nOpen}` });
  const closedTab = page.getByRole('button', { name: `Resolved · ${nClosed}` });
  check(
    'Views counts match /api/dashboard',
    (await openTab.count()) === 1 && (await closedTab.count()) === 1,
  );
  const opened = await statuses(page);
  check(
    'Views "Open" shows only open cases',
    opened.length === nOpen && opened.every((i) => /· Open$/.test(i.status)),
    `${opened.length}/${nOpen}`,
  );
  await closedTab.click();
  const closed = await statuses(page);
  check(
    'Views "Resolved" shows only resolved cases, without a priority chip',
    closed.length === nClosed && closed.every((i) => !i.priority && /· Resolved$/.test(i.status)),
    `${closed.length}/${nClosed}`,
  );
  await ctx.close();
});

await run('Search', async () => {
  const { ctx, page } = await open('marta');
  const item = page.locator('.case-item', { hasText: summary });
  const ref = await item.locator('.case-ref').innerText();
  check('Search short ref format', /^#[0-9A-Z]{6}$/.test(ref), ref);
  // OPX3: the search runs on the server; wait for its answer.
  const searched = () =>
    page.waitForResponse((r) => /\/api\/incidents\?/.test(r.url()) && r.status() === 200);
  const idle = () => page.locator('.case-list[aria-busy="false"]').waitFor();
  await Promise.all([searched(), page.getByLabel('Search cases').fill(ref.toLowerCase())]);
  await idle();
  const left = await page.locator('.case-item').allInnerTexts();
  check(
    'Search by short ref leaves exactly that case',
    left.length === 1 && left[0].includes(summary),
    `${left.length}`,
  );
  await Promise.all([searched(), page.getByLabel('Search cases').fill('zzz-no-such-case')]);
  await idle();
  check('Search with no match says so', (await page.getByText('No cases here.').count()) === 1);
  await ctx.close();
});

// OPX3: filters run on the server (GET /api/incidents?…); the Open/Resolved tabs count the result.
await run('Filters', async () => {
  const { ctx, page } = await open('marta', 1280, 900);
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('.case-item').first().waitFor();
  const all = await page.locator('.case-item').count();
  const filteredResponse = () =>
    page.waitForResponse((r) => /\/api\/incidents\?/.test(r.url()) && r.status() === 200);
  const idle = () => page.locator('.case-list[aria-busy="false"]').waitFor();
  await Promise.all([filteredResponse(), page.getByLabel('Search cases').fill('lucia')]);
  await idle();
  const names = await page.locator('.case-item .case-top strong').allInnerTexts();
  check(
    'Filters: a first name without its accent leaves only that customer',
    names.length > 0 && names.every((n) => n === 'Lucía Martín'),
    names.join(', '),
  );
  await page.getByLabel('Search cases').fill('');
  await Promise.all([
    filteredResponse(),
    page.getByRole('button', { name: 'Money at stake', exact: true }).click(),
  ]);
  await idle();
  const chips = await page
    .locator('.case-item')
    .evaluateAll((els) => els.map((el) => !!el.querySelector('.case-priority.money')));
  check(
    'Filters: "Money at stake" leaves only money cases, chip pressed',
    chips.length > 0 &&
      chips.every(Boolean) &&
      (await page
        .getByRole('button', { name: 'Money at stake', exact: true })
        .getAttribute('aria-pressed')) === 'true',
    `${chips.length}`,
  );
  await page.screenshot({ path: `${SHOTS}/filters-money-1280.png` });
  await Promise.all([
    filteredResponse(),
    page.getByLabel('Priority reason').selectOption('waiting'),
  ]);
  await idle();
  check(
    'Filters: contradictory filters show the empty state with "Clear filters"',
    (await page.locator('.case-item').count()) === 0 &&
      (await page.getByText('No cases here.').count()) === 1 &&
      (await page.getByRole('button', { name: 'Clear filters' }).count()) === 1,
  );
  await page.screenshot({ path: `${SHOTS}/filters-empty-1280.png` });
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page
    .locator('.case-item')
    .nth(all - 1)
    .waitFor();
  check(
    'Filters: Clear brings the full list back and resets the controls',
    (await page.locator('.case-item').count()) === all &&
      (await page.getByLabel('Priority reason').inputValue()) === '' &&
      (await page.getByRole('button', { name: 'Clear', exact: true }).count()) === 0,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await Promise.all([
    filteredResponse(),
    page.getByRole('button', { name: 'Money at stake', exact: true }).click(),
  ]);
  await idle();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  check('Filters: no horizontal scroll at 390', !overflow);
  await page.locator('.case-filters').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/filters-money-390.png` });
  check('Filters: clean console', errors.length === 0, errors.join(' | ').slice(0, 200));
  await ctx.close();
});

await run('Detail', async () => {
  const { ctx, page } = await open('marta');
  await openCase(page, page.locator('.case-item', { hasText: summary }));
  const detail = page.locator('.case-detail');
  const text = (await detail.innerText()).toLowerCase();
  check(
    'Recorded only: no internal note, failed-transfer or pending-proposal tags',
    !/internal note|failed transfer|pending proposal/.test(text),
  );
  const meta = detail.locator('.case-head small');
  const metaText = await meta.innerText();
  const box = await meta.boundingBox();
  check(
    'Header meta is "#REF · opened …" on one line',
    /^#[0-9A-Z]{6} · opened /.test(metaText) && box.height < 24,
    `${metaText} h=${box.height}`,
  );
  // U4: "Keep open" cancels the confirmation.
  await page.getByRole('button', { name: 'Mark resolved' }).click();
  await page.getByRole('button', { name: 'Keep open' }).click();
  check(
    'U4 Keep open leaves the case open',
    (await detail.locator('.status-pill').innerText()) === 'Open' &&
      (await page.getByRole('button', { name: 'Mark resolved' }).count()) === 1 &&
      (await page.getByText('Are you sure?').count()) === 0,
  );
  await page.screenshot({ path: `${SHOTS}/cases-detail-run.png` });
  await ctx.close();
});

await run('Mobile', async () => {
  const { ctx, page } = await open('marta', 390, 844);
  await page.locator('.case-item').first().waitFor();
  check(
    'Mobile: no empty detail placeholder before a case is chosen',
    !(await page.locator('.case-detail').isVisible()),
  );
  await openCase(page, page.locator('.case-item').first());
  await page.locator('.case-detail').waitFor({ state: 'visible' });
  check(
    'Mobile: detail shown once a case is selected',
    await page.locator('.case-detail').isVisible(),
  );
  await ctx.close();
});

// OPX2-ui: each open inbox row and the case header show the server's wait and level in words.
await run('Waiting', async () => {
  const { ctx, page } = await open('marta', 1280, 900);
  await page.locator('.case-item').first().waitFor();
  const { incidents } = await (await ctx.request.get(`${URL}/api/dashboard`)).json();
  const api = incidents.filter((c) => c.status === 'open');
  const label = { ok: 'Within target', warn: 'Near target', breach: 'Over target' };
  const rows = await page.locator('.case-item').evaluateAll((els) =>
    els.map((el) => ({
      waits: [...el.querySelectorAll('.case-wait')].map((w) => ({
        text: w.textContent,
        cls: w.className,
      })),
      wrote: [...el.querySelectorAll('small')].filter((s) =>
        /^Customer wrote .+ ago$/.test(s.textContent),
      ).length,
    })),
  );
  const bad = rows.findIndex((r, i) => {
    const lvl = api[i]?.waiting.level;
    return (
      r.waits.length !== 1 ||
      !/^Waiting (\d|under)/.test(r.waits[0].text) ||
      !r.waits[0].text.endsWith(` · ${label[lvl]}`) ||
      !r.waits[0].cls.split(' ').includes(lvl) ||
      r.wrote !== (api[i].waiting.sinceCustomerMs === null ? 0 : 1)
    );
  });
  check(
    'Waiting: every open row shows one wait with the server level in text and class',
    rows.length === api.length && rows.length > 0 && bad === -1,
    bad === -1 ? `${rows.length} rows` : JSON.stringify(rows[bad]),
  );
  const item = page.locator('.case-item', { hasText: summary });
  check(
    'Waiting: the new case waits "under 1 min · Within target"',
    (await item.locator('.case-wait').innerText()) === 'Waiting under 1 min · Within target',
    await item.locator('.case-wait').innerText(),
  );
  await openCase(page, item);
  const head = page.locator('.case-head .case-wait');
  check(
    'Waiting: the header shows the wait and level, with the opening time in the title',
    (await head.innerText()) === 'Waiting under 1 min · Within target' &&
      (await head.getAttribute('class')).split(' ').includes('ok') &&
      /^Opened .+ · near target after .+, target .+$/.test(await head.getAttribute('title')),
    await head.innerText(),
  );
  // The header card clips (overflow: auto), so page overflow alone would miss a pushed-out button.
  const inHead = async () => {
    const card = await page.locator('.case-head').boundingBox();
    return Promise.all(
      ['.status-pill', '.case-wait', '.primary-button'].map(async (sel) => {
        const b = await page.locator(`.case-head ${sel}`).first().boundingBox();
        return b.x >= card.x && b.x + b.width <= card.x + card.width + 0.5;
      }),
    ).then((all) => all.every(Boolean));
  };
  check('Waiting: status, wait and "Mark resolved" fit the header at 1280', await inHead());
  await page.screenshot({ path: `${SHOTS}/waiting-1280.png` });
  // A second case for Hugo, resolved through the API: its header reads the recorded resolution time.
  const h2 = await open('hugo');
  const conv2 = await (await h2.ctx.request.post(`${URL}/api/conversations`, { data: {} })).json();
  const summary2 = `Cases e2e ${tag}: resolved for the waiting check`;
  await h2.ctx.request.post(`${URL}/api/actions`, {
    data: { name: 'request_human', arguments: { summary: summary2 }, conversationId: conv2.id },
  });
  await h2.ctx.close();
  const { incidents: now } = await (await ctx.request.get(`${URL}/api/dashboard`)).json();
  const id2 = now.find((c) => c.summary === summary2).id;
  await ctx.request.post(`${URL}/api/incidents/${id2}/resolve`, { data: { confirm: true } });
  await page.reload();
  await page.getByRole('button', { name: /^Resolved · / }).click();
  await openCase(page, page.locator('.case-item', { hasText: summary2 }));
  const resolvedText = await head.innerText();
  check(
    'Waiting: a case resolved now reads "Resolved after under 1 min", no level',
    resolvedText === 'Resolved after under 1 min' &&
      (await head.getAttribute('class')) === 'case-wait',
    resolvedText,
  );
  // Seeded resolved cases predate the case.resolved event: the time is stated as not recorded.
  // Picked by its seeded id (server order = list order): other suites resolve cases of their own.
  const { incidents: closed } = await (await ctx.request.get(`${URL}/api/dashboard`)).json();
  const seeded = closed
    .filter((c) => c.status === 'closed')
    .findIndex((c) => c.id.startsWith('case-routine-'));
  await openCase(page, page.locator('.case-item').nth(seeded));
  check(
    'Waiting: a seeded resolved case says "Resolution time not recorded"',
    (await head.innerText()) === 'Resolution time not recorded',
    await head.innerText(),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /^Open · / }).click();
  await openCase(page, item);
  await page.locator('.case-head').scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  check('Waiting: no horizontal overflow at 390', !overflow);
  check('Waiting: status, wait and "Mark resolved" fit the header at 390', await inHead());
  await page.screenshot({ path: `${SHOTS}/waiting-390-header.png` });
  await item.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/waiting-390-inbox.png` });
  await ctx.close();
});

// INT1-ui: the rail states the audit chain status in words. "Broken" needs DATA_DIR (the running
// app's data dir): one of this case's events is edited in place, checked, then restored, which
// makes the chain verify again.
await run('Audit', async () => {
  const { ctx, page } = await open('marta', 1280, 900);
  const item = page.locator('.case-item', { hasText: summary });
  await openCase(page, item);
  const line = page.locator('.case-rail .audit-status .audit-line');
  check(
    'Audit: verified line with the step count',
    /^Audit log verified · \d+ steps? across all cases, no changes detected$/.test(
      await line.innerText(),
    ) && (await page.locator('.case-rail .audit-status.verified').count()) === 1,
    await line.innerText(),
  );
  await page.screenshot({ path: `${SHOTS}/audit-verified-1280.png` });
  const { default: Database } = await import('better-sqlite3');
  const { join } = await import('node:path');
  const db = new Database(join(DATA_DIR, 'app.sqlite'));
  const row = db
    .prepare('SELECT id, kind, data FROM events WHERE conversation_id=? ORDER BY rowid LIMIT 1')
    .get(conv.id);
  db.prepare('UPDATE events SET data=? WHERE id=?').run(`${row.data} `, row.id);
  try {
    await openCase(page, item);
    const text = await line.innerText();
    check(
      'Audit: broken line names the changed step, in text and not only colour',
      text.startsWith(`Audit log broken at step ${row.kind} · `) &&
        (await page.locator('.case-rail .audit-status.broken').count()) === 1 &&
        (await page.locator('.case-rail .audit-status').getByText('See Evidence gaps.').count()) ===
          1,
      text,
    );
    const bg = (sel) =>
      page
        .locator(sel)
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor);
    check(
      'Audit: broken keeps the normal card background (no red rail)',
      (await bg('.case-rail .audit-status')) === (await bg('.case-rail .audit-status + .card')),
    );
    await page.screenshot({ path: `${SHOTS}/audit-broken-1280.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.case-rail .audit-status').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/audit-broken-390.png` });
  } finally {
    db.prepare('UPDATE events SET data=? WHERE id=?').run(row.data, row.id);
    db.close();
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await openCase(page, item);
  check(
    'Audit: restoring the row verifies the chain again',
    (await line.innerText()).startsWith('Audit log verified · '),
  );
  await ctx.close();
});

// OPX4-ui: the rail lists who viewed and resolved the case, newest first, with local times.
await run('Activity', async () => {
  const { ctx, page } = await open('marta', 1280, 900);
  const item = page.locator('.case-item', { hasText: summary });
  await openCase(page, item);
  const card = page.locator('.case-rail .case-activity');
  const rows = card.locator('.activity-list li');
  const first = await rows.first().innerText();
  check(
    'Activity: opening the case lists "Viewed by Marta" with a time',
    first.startsWith('Viewed by Marta') &&
      (await rows.first().locator('time[datetime]').count()) === 1,
    first.replace('\n', ' | '),
  );
  check(
    'Activity: "Assistant steps" has no "Viewed by" line',
    !/Viewed by/.test(
      await page
        .locator('.case-rail')
        .innerText()
        .then((t) => t.split('Case activity')[0]),
    ),
  );
  await page.getByRole('button', { name: 'Mark resolved' }).click();
  await Promise.all([
    page.waitForResponse((r) => /\/api\/incidents\/[^/]+\/resolve$/.test(r.url())),
    page.getByRole('button', { name: 'Yes, mark resolved' }).click(),
  ]);
  await card.getByText('Marked resolved by Marta').waitFor();
  check(
    'Activity: resolving adds "Marked resolved by Marta" on top',
    (await rows.first().innerText()).startsWith('Marked resolved by Marta'),
  );
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: `${SHOTS}/activity-1280.png` });
  // Long list: pad the detail response with older rows; the card caps it and expands on demand.
  await page.route(/\/api\/incidents\/[^/]+$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    for (let i = 0; i < 12; i++)
      body.activity.push({
        id: `pad-${i}`,
        kind: 'case.viewed',
        at: new Date(Date.parse(body.incident.created_at) - i * 60_000).toISOString(),
        operatorId: 'marta',
        operatorName: 'Marta',
        description: `Viewed by Padded ${i}`,
      });
    await route.fulfill({ response: res, json: body });
  });
  // Resolved now: the case lives under the "Resolved" tab.
  await page.getByRole('button', { name: /^Resolved · / }).click();
  await openCase(page, item);
  const total = await card.locator('.activity-list li').count();
  const more = card.getByRole('button', { name: /^Show all \d+$/ });
  check(
    'Activity: long list capped at 8 with "Show all"',
    total === 8 && (await more.count()) === 1,
    `${total}`,
  );
  await more.click();
  check('Activity: "Show all" lists every row', (await rows.count()) > 8, `${await rows.count()}`);
  await page.unroute(/\/api\/incidents\/[^/]+$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await openCase(page, item);
  await card.scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  check('Activity: no horizontal overflow at 390', !overflow);
  await card.screenshot({ path: `${SHOTS}/activity-390.png` });
  await ctx.close();
});

// OPX1-ui: the header's Export menu downloads the evidence bundle (JSON) and the printable report
// (HTML); the case then lists the export in "Case activity". Errors show inside the menu.
await run('Export', async () => {
  const { readFile } = await import('node:fs/promises');
  const { ctx, page } = await open('marta', 1280, 900);
  const problems = [];
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));
  // Resolved by the Activity block: exports work for resolved cases too.
  await page.getByRole('button', { name: /^Resolved · / }).click();
  const item = page.locator('.case-item', { hasText: summary });
  await openCase(page, item);
  const ref = (await item.locator('.case-ref').innerText()).slice(1);
  const menu = page.locator('.case-head .export-menu');
  const exportAs = async (name) => {
    await menu.locator('summary').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.waitForResponse((r) => /\/api\/incidents\/[^/]+$/.test(r.url())),
      page.getByRole('link', { name }).click(),
    ]);
    return {
      name: download.suggestedFilename(),
      body: await readFile(await download.path(), 'utf8'),
    };
  };
  const json = await exportAs('Evidence bundle (JSON)');
  let bundle = null;
  try {
    bundle = JSON.parse(json.body);
  } catch {}
  check(
    'Export JSON: file case-{REF}-{YYYYMMDD}.json',
    new RegExp(`^case-${ref}-\\d{8}\\.json$`).test(json.name),
    json.name,
  );
  check(
    'Export JSON: parses, is this case, includes the audit chain status',
    bundle?.format === 'banana-case-bundle' &&
      bundle.case?.incident?.summary === summary &&
      ['verified', 'broken', 'empty'].includes(bundle.integrity?.chain?.status),
    bundle?.integrity?.chain?.status,
  );
  const card = page.locator('.case-rail .case-activity');
  await card.getByText('Exported as JSON by Marta').waitFor({ timeout: 5000 });
  check(
    'Export: "Case activity" then lists "Exported as JSON by Marta" on top',
    (await card.locator('.activity-list li').first().innerText()).startsWith(
      'Exported as JSON by Marta',
    ),
  );
  check('Export: menu closes after a download', !(await menu.evaluate((d) => d.open)));
  const html = await exportAs('Printable report (HTML)');
  check(
    'Export HTML: file case-{REF}-{YYYYMMDD}.html, no <script>, names the case',
    new RegExp(`^case-${ref}-\\d{8}\\.html$`).test(html.name) &&
      !/<script/i.test(html.body) &&
      html.body.includes('Hugo'),
    html.name,
  );
  // Errors: a 404 (case gone) is shown in the menu, not as a failed browser download.
  await page.route(/\/export\?/, (route) =>
    route.fulfill({ status: 404, json: { error: 'Case not found.' } }),
  );
  await menu.locator('summary').click();
  await page.getByRole('link', { name: 'Evidence bundle (JSON)' }).click();
  const alert = menu.getByRole('alert');
  await alert.waitFor();
  check(
    'Export: a 404 shows the server message in the menu',
    (await alert.innerText()) === 'Case not found.',
  );
  await page.unroute(/\/export\?/);
  await page.keyboard.press('Escape');
  check('Export: Escape closes the menu', !(await menu.evaluate((d) => d.open)));
  await menu.locator('summary').click();
  check('Export: reopening clears the old error', (await alert.count()) === 0);
  await page.keyboard.press('Escape');
  // Keyboard: Tab to the summary, Enter opens, the links are reachable.
  await menu.locator('summary').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  check(
    'Export: keyboard opens the menu and reaches the first link',
    (await menu.evaluate((d) => d.open)) &&
      (await page.evaluate(() => document.activeElement?.textContent)) ===
        'Printable report (HTML)',
  );
  await page.screenshot({ path: `${SHOTS}/export-menu-1280.png` });
  // OP5: Safari does not focus a link on mouse click, so opening by keyboard and then clicking a
  // link blurs the focused link with no relatedTarget. Simulate that focusout, then click.
  await page.evaluate(() =>
    document.activeElement.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: null }),
    ),
  );
  await page.waitForTimeout(100);
  check(
    'OP5 focusout with no relatedTarget keeps the menu open',
    await menu.evaluate((d) => d.open),
  );
  const safari = await Promise.all([
    page.waitForEvent('download', { timeout: 3000 }),
    page.getByRole('link', { name: 'Evidence bundle (JSON)' }).click({ timeout: 2000 }),
  ]).catch(() => null);
  check(
    'OP5 then a mouse click on a link downloads',
    !!safari && /\.json$/.test(safari[0].suggestedFilename()),
    safari?.[0].suggestedFilename() ?? 'no download',
  );
  // OP5: pointer down outside and Tab out still close it.
  await menu.locator('summary').click();
  await page.locator('.page-heading').click();
  check('OP5 a click outside closes the menu', !(await menu.evaluate((d) => d.open)));
  await menu.locator('summary').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  check(
    'OP5 Tab out of the last link closes the menu',
    !(await menu.evaluate((d) => d.open)) &&
      !(await menu.evaluate((d) => d.contains(document.activeElement))),
  );
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await openCase(page, item);
  await menu.locator('summary').click();
  const box = await menu.locator('.export-options').boundingBox();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  check(
    'Export: menu fits at 390, no horizontal overflow',
    !overflow && box.x >= 0 && box.x + box.width <= 390,
    `x=${Math.round(box.x)} w=${Math.round(box.width)}`,
  );
  await page.screenshot({ path: `${SHOTS}/export-menu-390.png` });
  // The 404 above is fulfilled on purpose; Chrome logs it as a failed resource.
  const unexpected = problems.filter((t) => !/status of 404/.test(t));
  check(
    'Export: no console errors or CSP violations',
    unexpected.length === 0,
    unexpected.join(' | '),
  );
  await ctx.close();
});

await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
