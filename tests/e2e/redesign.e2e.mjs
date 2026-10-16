// Redesign checks (docs/plan/15-redesign/), extended by every slice. Slice 1: shell and round 4
// U1, U2, U5, U6. No model calls: the proposal goes through POST /api/actions and is cancelled
// at the end.
// Run: APP_URL=http://127.0.0.1:3900 node tests/e2e/redesign.e2e.mjs
// Playwright setup and overrides (PLAYWRIGHT_MODULE, PLAYWRIGHT_CHANNEL): README "End-to-end checks".
import { APP_URL as URL, launch } from './env.mjs';
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
async function open(persona = 'lucia', viewport = { width: 1440, height: 900 }, wait = true) {
  const ctx = await browser.newContext({ viewport });
  await ctx.request.post(`${URL}/api/session`, { data: { userId: persona } });
  await ctx.addInitScript((p) => localStorage.setItem('banana_person', p), persona);
  const page = await ctx.newPage();
  if (wait) {
    await page.goto(URL);
    await page.waitForSelector('.page-heading');
  }
  return { ctx, page };
}
const nav = (page, label) => page.locator('nav button', { hasText: label }).click();
const active = async (page) =>
  (await page.locator('nav button[aria-current="page"]').allInnerTexts()).join('|').trim();
const sidebarWidth = async (page) =>
  Math.round((await page.locator('.sidebar').boundingBox()).width);

// U1: a failed load shows an error state with Retry; the selector stays usable.
await run('U1', async () => {
  const { ctx, page } = await open('lucia', undefined, false);
  const stub = (route) =>
    route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'The bank is not responding (stub).' }),
    });
  await page.route('**/api/dashboard', stub);
  await page.goto(URL);
  const box = page.locator('.load-error');
  await box.waitFor({ timeout: 8000 });
  const retry = box.getByRole('button', { name: 'Retry' });
  check(
    'U1 load error shown with a Retry button',
    (await retry.count()) === 1,
    await box.innerText(),
  );
  check('U1 no duplicate error alert', (await page.locator('.alert.error').count()) === 0);
  check('U1 person selector enabled', !(await page.getByLabel('Switch person').isDisabled()));
  await page.unroute('**/api/dashboard', stub);
  await retry.click();
  await page.waitForSelector('.page-heading', { timeout: 8000 });
  check('U1 Retry loads the page', (await page.locator('.load-error').count()) === 0);
  await ctx.close();
});

// U2: the proposals panel only on Transfers and Assistant.
await run('U2', async () => {
  const { ctx, page } = await open();
  const r = await ctx.request.post(`${URL}/api/actions`, {
    data: {
      name: 'transfer_money',
      arguments: {
        fromAccountId: 'acc-lucia',
        toAccountId: 'acc-carla',
        amountCents: 125,
        concept: `U2 ${Date.now()}`,
      },
      intentId: `redesign-u2-${Date.now()}`,
    },
  });
  const body = await r.json();
  if (body.status !== 'requires_confirmation') throw new Error(JSON.stringify(body));
  try {
    await page.reload();
    await page.waitForSelector('.page-heading');
    const counts = {};
    for (const tab of ['Overview', 'Transfers', 'Assistant', 'Documents']) {
      await nav(page, tab);
      // Slice 6: the Assistant tab has no .page-heading (full-height chat); wait for its layout.
      await page.waitForSelector(tab === 'Assistant' ? '.chat-layout' : '.page-heading');
      await page.waitForTimeout(300);
      counts[tab] = await page.locator('.approvals').count();
    }
    check(
      'U2 no proposals panel on Overview and Documents',
      counts.Overview === 0 && counts.Documents === 0,
      JSON.stringify(counts),
    );
    check(
      'U2 proposals panel on Transfers and Assistant',
      counts.Transfers === 1 && counts.Assistant === 1,
      JSON.stringify(counts),
    );
  } finally {
    // Rerunnable without reset: the proposal is cancelled even when a check throws.
    await ctx.request.post(`${URL}/api/approvals/${body.approval.id}/cancel`, { data: {} });
    await ctx.close();
  }
});

// U5: the tab lives in the URL; reload and back keep the place.
await run('U5', async () => {
  const { ctx, page } = await open();
  await nav(page, 'Transfers');
  check('U5 URL names the tab', page.url().includes('?tab=transfers'), page.url());
  await page.reload();
  await page.waitForSelector('.page-heading');
  check('U5 reload keeps Transfers', (await active(page)) === 'Transfers', await active(page));
  await page.goBack();
  await page
    .waitForFunction(
      () =>
        document
          .querySelector('nav button[aria-current="page"]')
          ?.textContent?.includes('Overview'),
      null,
      { timeout: 5000 },
    )
    .catch(() => {});
  check(
    'U5 back returns to Overview',
    (await active(page)).startsWith('Overview'),
    await active(page),
  );
  await ctx.close();
});

// U6: skip link is the first focusable element and moves focus to <main>.
await run('U6', async () => {
  const { ctx, page } = await open();
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => document.activeElement?.className);
  check('U6 first Tab focuses the skip link', first === 'skip-link', first);
  await page.keyboard.press('Enter');
  const id = await page.evaluate(() => document.activeElement?.id);
  check('U6 Enter moves focus to main', id === 'main', id);
  await ctx.close();
});

// Sidebar collapse: 72 px, labels stay in the DOM, expand icon on hover/focus, persisted.
await run('Sidebar', async () => {
  const { ctx, page } = await open();
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await page.waitForTimeout(350);
  check(
    'Sidebar collapses to 72 px',
    (await sidebarWidth(page)) === 72,
    String(await sidebarWidth(page)),
  );
  const text = await page.locator('nav').textContent();
  check(
    'Sidebar nav labels stay in the DOM',
    ['Overview', 'Assistant', 'Transfers', 'Documents'].every((l) => text.includes(l)),
    text,
  );
  await page.reload();
  await page.waitForSelector('.page-heading');
  await page.waitForTimeout(350);
  check(
    'Sidebar collapsed state persists after reload',
    (await sidebarWidth(page)) === 72,
    String(await sidebarWidth(page)),
  );
  const toggle = page.getByRole('button', { name: 'Expand sidebar' });
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  const onFocus = await page.locator('.glyph-expand').isVisible();
  check(
    'Sidebar expand icon shown on keyboard focus',
    focused === 'Expand sidebar' && onFocus,
    `focused=${focused}`,
  );
  await page.mouse.click(1000, 500);
  await toggle.hover();
  check('Sidebar expand icon shown on hover', await page.locator('.glyph-expand').isVisible());
  await toggle.click();
  await page.waitForTimeout(350);
  check(
    'Sidebar expands to 244 px',
    (await sidebarWidth(page)) === 244,
    String(await sidebarWidth(page)),
  );
  await ctx.close();
});

// Mobile shell: the same single <nav> is a bottom tab bar; no horizontal scroll.
await run('Mobile', async () => {
  const { ctx, page } = await open('lucia', { width: 390, height: 844 });
  check('Mobile exactly one nav', (await page.locator('nav').count()) === 1);
  const box = await page.locator('nav').boundingBox();
  const bar = await page.locator('.sidebar').boundingBox();
  check(
    'Mobile tab bar at the bottom',
    Math.abs(bar.y + bar.height - 844) <= 1 && box.y > 700,
    `nav y=${box.y} bar bottom=${bar.y + bar.height}`,
  );
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  check('Mobile no horizontal scroll', width <= 390, String(width));
  await ctx.close();
});

await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
