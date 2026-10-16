// CF5-ui notification bell against a running app. No model calls: the proposal goes through
// POST /api/actions, and its expires_at is moved to 2 minutes from now in the e2e app database
// (DATA_DIR) so CF5-api derives a `proposal_expiring` item. Omar is used because no other e2e
// suite writes his proposals. The bank scenario is not changed.
//
// Run (app and bank already running on DATA_DIR):
//   APP_URL=http://127.0.0.1:3900 DATA_DIR=.data-e2e-cf node tests/e2e/notifications.e2e.mjs
// PLAYWRIGHT_MODULE / PLAYWRIGHT_CHANNEL / SHOTS as in the other e2e scripts.
import path from 'node:path';
import Database from 'better-sqlite3';
import { APP_URL as URL, launch, SHOTS, requireDataDir } from './env.mjs';
// The fixture is written straight into the app database, so DATA_DIR must name the running app's
// own (e2e) data dir; there is no default, so the dev `.data` is never touched by accident.
const DATA_DIR = requireDataDir();
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
const consoleErrors = [];
async function open(persona, viewport = { width: 1280, height: 860 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.request.post(`${URL}/api/session`, { data: { userId: persona } });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${persona}: ${m.text()}`));
  page.on('pageerror', (e) => consoleErrors.push(`${persona}: ${e.message}`));
  await page.addInitScript((p) => localStorage.setItem('banana_person', p), persona);
  await page.goto(`${URL}/?tab=overview`);
  await page.waitForSelector('.page-heading');
  return { ctx, page };
}
const unread = async (ctx) =>
  (await (await ctx.request.get(`${URL}/api/notifications`)).json()).unread;
const cents = 301 + (Date.now() % 600);
const money = `€${(cents / 100).toFixed(2)}`;
let approvalId = '';

await run('customer bell', async () => {
  const { ctx, page } = await open('omar');
  // Start from a clean slate: earlier runs may have left items.
  await ctx.request.post(`${URL}/api/notifications/read`, { data: { all: true } });
  const dash = await (await ctx.request.get(`${URL}/api/dashboard`)).json();
  const r = await (
    await ctx.request.post(`${URL}/api/actions`, {
      data: {
        name: 'transfer_money',
        arguments: {
          fromAccountId: dash.accounts[0].id,
          recipient: 'carla',
          amountCents: cents,
          concept: 'CF5 bell',
        },
        intentId: `cf5-ui-${Date.now()}`,
      },
    })
  ).json();
  if (r.status !== 'requires_confirmation') throw new Error(JSON.stringify(r));
  approvalId = r.approval.id;
  const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
  const moved = db
    .prepare('UPDATE approvals SET expires_at=? WHERE id=?')
    .run(new Date(Date.now() + 2 * 60_000).toISOString(), approvalId).changes;
  db.close();
  if (moved !== 1) throw new Error(`DATA_DIR ${DATA_DIR} is not the running app's data dir`);
  check('API derives one unread item', (await unread(ctx)) === 1);

  await page.reload();
  const bell = page.locator('header.topbar button.notification-bell');
  await page.locator('.notification-bell .count-badge').waitFor({ timeout: 8000 });
  check(
    'bell sits in the topbar, before the persona control',
    await page.evaluate(() => {
      const b = document.querySelector('.topbar > .notification-bell');
      const p = document.querySelector('.topbar > .persona-control');
      return (
        !!b &&
        !!p &&
        !!(b.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        !b.closest('nav')
      );
    }),
  );
  check('badge shows the unread count', (await bell.locator('.count-badge').innerText()) === '1');
  check(
    'accessible name names the count',
    (await bell.getAttribute('aria-label')) === 'Notifications, 1 unread',
  );
  check('only one nav', (await page.locator('nav').count()) === 1);
  await page.screenshot({ path: `${SHOTS}/bell-closed-1280.png` });

  await bell.click();
  const panel = page.locator('dialog.notification-panel');
  await panel.waitFor();
  check('dialog opens modal', await panel.evaluate((d) => d.open && d.matches(':modal')));
  const item = panel.locator('li.notification-item', { hasText: money });
  await item.waitFor();
  const text = (await item.innerText()).replace(/\s+/g, ' ');
  check(
    'item text and time',
    /Confirm or cancel soon/.test(text) &&
      text.includes('Carla Ríos') &&
      (await item.locator('time').count()) === 1,
    text,
  );
  check(
    'item keeps its unread highlight while open',
    await item.evaluate((li) => li.classList.contains('unread')),
  );
  await page.screenshot({ path: `${SHOTS}/bell-open-1280.png` });
  check('badge clears on open', (await bell.locator('.count-badge').count()) === 0);
  let serverUnread = -1;
  for (let i = 0; i < 20 && serverUnread !== 0; i++) {
    serverUnread = await unread(ctx);
    if (serverUnread) await page.waitForTimeout(250);
  }
  check('server marks it read', serverUnread === 0);

  await page.keyboard.press('Escape');
  check('Esc closes', !(await panel.evaluate((d) => d.open)));
  check('focus returns to the bell', await bell.evaluate((b) => document.activeElement === b));
  await page.keyboard.press('Enter');
  check('Enter on the bell opens it', await panel.evaluate((d) => d.open));
  check(
    'focus moves into the dialog',
    await panel.evaluate((d) => d.contains(document.activeElement)),
  );
  check(
    'item no longer unread after reopening',
    !(await item.evaluate((li) => li.classList.contains('unread'))),
  );
  await page.mouse.click(20, 700);
  check('click outside closes', !(await panel.evaluate((d) => d.open)));
  check(
    'reload keeps no badge',
    await (async () => {
      await page.reload();
      await page.waitForSelector('.notification-bell');
      await page.waitForTimeout(1000);
      return (
        (await bell.locator('.count-badge').count()) === 0 &&
        (await bell.getAttribute('aria-label')) === 'Notifications'
      );
    })(),
  );
  await bell.click();
  await item.locator('button').click();
  check(
    'item click goes to Transfers and closes',
    !(await panel.evaluate((d) => d.open)) &&
      /Transfers/.test(await page.locator('nav button[aria-current="page"]').innerText()),
  );
  await ctx.close();
});

await run('mobile', async () => {
  const { ctx, page } = await open('omar', { width: 390, height: 844 });
  const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
  // A second unread item for the screenshots: the same proposal, now unmarked.
  db.prepare("DELETE FROM notification_reads WHERE user_id='omar' AND notification_id=?").run(
    `expiring:${approvalId}`,
  );
  db.close();
  await page.reload();
  const bell = page.locator('.notification-bell');
  await bell.locator('.count-badge').waitFor({ timeout: 8000 });
  check('bell visible in the mobile header', await bell.isVisible());
  const sw = () => page.evaluate(() => document.documentElement.scrollWidth);
  check('no horizontal scroll at 390 (closed)', (await sw()) <= 390, `scrollWidth=${await sw()}`);
  await page.screenshot({ path: `${SHOTS}/bell-closed-390.png` });
  await bell.click();
  const panel = page.locator('dialog.notification-panel');
  await panel.locator('li.notification-item').first().waitFor();
  const box = await panel.boundingBox();
  check(
    'panel is a bottom sheet',
    Math.abs(box.y + box.height - 844) < 2 && box.width === 390,
    JSON.stringify(box),
  );
  check('no horizontal scroll at 390 (open)', (await sw()) <= 390, `scrollWidth=${await sw()}`);
  await page.screenshot({ path: `${SHOTS}/bell-open-390.png` });
  await page.keyboard.press('Escape');
  await ctx.close();
});

await run('operator', async () => {
  const { ctx, page } = await open('marta');
  const calls = [];
  page.on('request', (r) => r.url().includes('/api/notifications') && calls.push(r.url()));
  await page.reload();
  await page.waitForSelector('.page-heading');
  await page.waitForTimeout(1000);
  check('operators see no bell', (await page.locator('.notification-bell').count()) === 0);
  check('operators do not poll notifications', calls.length === 0, calls.join(' '));
  await ctx.close();
});

check(
  'clean console (no errors, no CSP violations)',
  consoleErrors.length === 0,
  consoleErrors.join(' | '),
);

// Rerunnable without a reset: cancel this run's proposal.
if (approvalId) {
  const cleanup = await browser.newContext();
  await cleanup.request.post(`${URL}/api/session`, { data: { userId: 'omar' } });
  await cleanup.request.post(`${URL}/api/approvals/${approvalId}/cancel`, { data: {} });
  await cleanup.close();
}
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
