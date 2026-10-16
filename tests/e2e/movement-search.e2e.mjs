// CF3-ui: movement search and filters on Overview, against a running app (production build).
// CF2: the "Download CSV" link (same filters as the screen).
// Read-only: no transfer is made, no model call. Reads Lucía's seeded movements ("Team dinner",
// "Groceries", "Savings account opening" on Personal savings).
//
// Run (app and bank already running):
//   APP_URL=http://127.0.0.1:3900 node tests/e2e/movement-search.e2e.mjs
// PLAYWRIGHT_MODULE / PLAYWRIGHT_CHANNEL / SHOTS as in the other e2e scripts.
import fs from 'node:fs';
import { APP_URL as URL, launch, SHOTS } from './env.mjs';
const browser = await launch();
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
async function run(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name, false, `threw: ${e.message.split('\n')[0]}`);
  }
}
async function open(viewport) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  await ctx.request.post(`${URL}/api/session`, { data: { userId: 'lucia' } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));
  await page.addInitScript(() => localStorage.setItem('banana_person', 'lucia'));
  await page.goto(`${URL}/?tab=overview`);
  await page.locator('.movements .movement').first().waitFor();
  return { ctx, page, problems };
}
const rows = (page) => page.locator('.movements .movement');
const status = (page) => page.locator('.movement-filters [role="status"]');
const search = (page) => page.getByRole('searchbox', { name: 'Search transactions' });
const waitStatus = (page, re) =>
  page.waitForFunction(
    ([sel, src]) => new RegExp(src).test(document.querySelector(sel)?.textContent ?? ''),
    ['.movement-filters [role="status"]', re.source],
  );
const texts = async (page) => (await rows(page).allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));

await run('Desktop', async () => {
  const { ctx, page, problems } = await open({ width: 1280, height: 900 });
  const before = await rows(page).count();

  await search(page).fill('team dinner');
  await waitStatus(page, /\d+ results?/);
  const found = await texts(page);
  const n = Number((await status(page).innerText()).match(/\d+/)[0]);
  check(
    'text search narrows the rows (debounced, accent/case-insensitive)',
    found.length === n && n >= 1 && n < before && found.every((t) => /Team dinner/i.test(t)),
    `${n} of ${before}: ${found.join(' | ')}`,
  );
  check(
    'the search sits in the designer toolbar row',
    (await page.locator('.movements .activity-toolbar search.movement-filters').count()) === 1,
  );
  await page.screenshot({ path: `${SHOTS}/search-1280.png`, fullPage: true });

  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.getByLabel('Direction').selectOption('received');
  await waitStatus(page, /\d+ results?/);
  const received = await texts(page);
  const credits = await page.locator('.movements .movement .amount.credit').count();
  check(
    'direction "Received" keeps only credits (no Groceries)',
    received.length > 0 &&
      credits === received.length &&
      !received.some((t) => /Groceries/.test(t)),
    received.join(' | '),
  );
  const toggle = (await page.getByRole('button', { name: /^Filters/ }).innerText()).replace(
    /\s+/g,
    ' ',
  );
  check('the Filters toggle counts the active filters', /Filters \(1\)/.test(toggle), toggle);

  await page.locator('.segmented').getByRole('button', { name: 'Personal savings' }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.movements .movement .movement-account')].every((e) =>
      /Personal savings/.test(e.textContent),
    ),
  );
  const savings = await texts(page);
  check(
    'account filter (segmented) is sent with the search',
    savings.length >= 1 &&
      savings.some((t) => /Savings account opening/.test(t)) &&
      !savings.some((t) => /September salary/.test(t)),
    savings.join(' | '),
  );
  await page.screenshot({ path: `${SHOTS}/filters-open-1280.png`, fullPage: true });
  await page.locator('.segmented').getByRole('button', { name: 'All', exact: true }).click();
  await page.getByLabel('Direction').selectOption('');

  await search(page).fill('zzz no such movement');
  await waitStatus(page, /0 results/);
  const emptyText = await page.locator('.movements .empty-state').innerText();
  check(
    'empty state (emptyText): no rows, column head and "View all" hidden',
    (await rows(page).count()) === 0 &&
      emptyText === 'No transactions match these filters.' &&
      !(await page.locator('.movements .movements-head').isVisible()) &&
      !(await page.getByRole('button', { name: 'View all' }).isVisible()),
    emptyText,
  );
  await page.screenshot({ path: `${SHOTS}/empty-1280.png`, fullPage: true });
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.waitForFunction(
    (b) => document.querySelectorAll('.movements .movement').length === b,
    before,
  );
  check(
    '"Clear filters" restores the dashboard rows and empties the search',
    (await rows(page).count()) === before && (await search(page).inputValue()) === '',
  );

  await page.getByLabel('Min amount (€)').fill('abc');
  await waitStatus(page, /Enter amounts in euros, like 12\.50\./);
  check('a bad amount shows an inline error', await page.locator('.filter-error').isVisible());
  await page.getByLabel('Min amount (€)').fill('20');
  await page.getByLabel('Max amount (€)').fill('10');
  await waitStatus(page, /The minimum amount is above the maximum\./);
  check('min above max shows the API message inline', true);
  await page.getByRole('button', { name: 'Clear', exact: true }).click();

  // Keyboard: search box → Filters toggle (Enter opens) → first date field.
  await page.getByRole('button', { name: /^Filters/ }).click();
  await search(page).focus();
  await page.keyboard.press('Tab');
  const onToggle = await page.evaluate(() =>
    document.activeElement?.textContent?.startsWith('Filters'),
  );
  await page.keyboard.press('Enter');
  const expanded = await page
    .getByRole('button', { name: /^Filters/ })
    .getAttribute('aria-expanded');
  await page.keyboard.press('Tab');
  const onFrom = await page.evaluate(() =>
    document.activeElement?.closest('label')?.textContent?.startsWith('From'),
  );
  await search(page).focus();
  await page.keyboard.type('groceries');
  await page.keyboard.press('Enter');
  await waitStatus(page, /1 result/);
  check(
    'keyboard: Tab to Filters, Enter opens, Tab reaches From; Enter searches',
    onToggle && expanded === 'true' && onFrom,
    `${onToggle} ${expanded} ${onFrom}`,
  );

  check('clean console', problems.length === 0, problems.join(' | '));
  await ctx.close();
});

// CF2: a minimal RFC 4180 reader (quoted fields may hold commas, quotes and newlines).
function parseCsv(text) {
  const out = [[]];
  let field = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') ((field += '"'), i++);
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') (out.at(-1).push(field), (field = ''));
    else if (c === '\r' && text[i + 1] === '\n')
      (out.at(-1).push(field), (field = ''), out.push([]), i++);
    else field += c;
  }
  out.pop();
  return out;
}

await run('CSV export (CF2)', async () => {
  const { ctx, page, problems } = await open({ width: 1280, height: 900 });
  const link = page.getByRole('link', { name: 'Download CSV' });
  const all = await link.getAttribute('href');
  check(
    'with no filter the link exports every movement, with the EUR hint',
    all === '/api/movements/export.csv' &&
      (await link.getAttribute('aria-describedby')) === 'movement-export-hint' &&
      (await page.locator('#movement-export-hint').innerText()) === 'Amounts in EUR',
    all,
  );
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.getByLabel('Direction').selectOption('received');
  await waitStatus(page, /\d+ results?/);
  const screen = await texts(page);
  await page.screenshot({ path: `${SHOTS}/csv-1280.png`, fullPage: true });
  await page.waitForFunction(() =>
    document
      .querySelector('.filter-export a')
      ?.getAttribute('href')
      ?.includes('direction=received'),
  );
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  const name = download.suggestedFilename();
  const bytes = fs.readFileSync(await download.path());
  fs.writeFileSync(`${SHOTS}/received.csv`, bytes);
  const text = bytes.toString('utf8');
  const [, ...lines] = parseCsv(text.replace(/^﻿/, ''));
  check(
    'filename banana-movements-all-<today>.csv',
    /^banana-movements-all-\d{4}-\d{2}-\d{2}\.csv$/.test(name),
    name,
  );
  check(
    'file starts with the BOM and the header row',
    text.startsWith('﻿date,account,description,details,direction,amount,currency,reference\r\n'),
  );
  check(
    'CSV rows match the on-screen results (count, order, direction, amount)',
    lines.length === screen.length &&
      lines.every(
        (r, i) =>
          r.length === 8 &&
          r[4] === 'received' &&
          r[6] === 'EUR' &&
          Number(r[5]) > 0 &&
          screen[i].includes(r[2]),
      ),
    `${lines.length} rows vs ${screen.length} on screen: ${lines.map((r) => r[2]).join(' | ')}`,
  );
  // Without a session the link answers the API's JSON 401, never a file.
  await ctx.clearCookies();
  const anonymous = await ctx.request.get(`${URL}/api/movements/export.csv`);
  check('no session: 401 JSON', anonymous.status() === 401, String(anonymous.status()));
  check('clean console (CSV)', problems.length === 0, problems.join(' | '));
  await ctx.close();
});

await run('Mobile 390', async () => {
  const { ctx, page, problems } = await open({ width: 390, height: 844 });
  await search(page).fill('team dinner');
  await waitStatus(page, /\d+ results?/);
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.getByLabel('Direction').waitFor();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  check(
    'the Download CSV link is visible at 390',
    await page.getByRole('link', { name: 'Download CSV' }).isVisible(),
  );
  check(
    'no horizontal scroll at 390 with the filters open',
    overflow <= 0,
    `overflow ${overflow}px`,
  );
  await page.screenshot({ path: `${SHOTS}/filters-open-390.png`, fullPage: true });
  check('clean console (390)', problems.length === 0, problems.join(' | '));
  await ctx.close();
});

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
