// B3, B11, A24g: the shell when the dashboard cannot be read, and the 404 page. The dashboard
// failure is a stubbed 504, so the suite needs no bank scenario and no model.
// Run: APP_URL=http://127.0.0.1:3900 node tests/e2e/shell-resilience.e2e.mjs
// Playwright setup and overrides (PLAYWRIGHT_MODULE, PLAYWRIGHT_CHANNEL): README "End-to-end checks".
import { APP_URL as URL, launch, requireSeed } from './env.mjs';
await requireSeed(URL);
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
const DOWN = 'The bank did not respond. Try again in a moment.';
const stub = (route) =>
  route.fulfill({
    status: 504,
    contentType: 'application/json',
    body: JSON.stringify({ error: DOWN }),
  });
async function open(persona) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.request.post(`${URL}/api/session`, { data: { userId: persona } });
  await ctx.addInitScript((p) => localStorage.setItem('banana_person', p), persona);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}
const nav = (page, label) => page.locator('nav button', { hasText: label }).click();
const loadError = (page) => page.locator('.load-error');
const spinners = (page) => page.locator('main > .loading').count();

await run('B3', async () => {
  const { ctx, page, errors } = await open('lucia');
  await page.route('**/api/dashboard', stub);
  await page.goto(`${URL}/?tab=overview`);
  await loadError(page).waitFor({ timeout: 8000 });
  for (const label of ['Transfers', 'Assistant']) {
    await nav(page, label);
    await page.waitForTimeout(500);
    check(
      `B3 ${label} opened with the dashboard down: the load error with Retry, no spinner`,
      (await loadError(page).getByRole('button', { name: 'Retry' }).count()) === 1 &&
        (await spinners(page)) === 0,
      `${await loadError(page).count()} load error, ${await spinners(page)} spinner`,
    );
  }
  const listed = await page.locator('.conversation-list button').count();
  check('B3 the conversations are listed without the dashboard', listed > 0, `${listed}`);
  await page.locator('.conversation-list button', { hasText: 'Contact details' }).click();
  await page.waitForSelector('.messages .message', { timeout: 8000 });
  check(
    'B3 a past conversation opens and the load error stays above it',
    (await page.locator('.messages .message').count()) > 0 && (await loadError(page).count()) === 1,
  );
  await nav(page, 'Documents');
  await page.waitForSelector('.doc-badge', { timeout: 8000 });
  check('B3 Documents needs no dashboard: no load error', (await loadError(page).count()) === 0);
  await nav(page, 'Transfers');
  await page.unroute('**/api/dashboard', stub);
  await loadError(page).getByRole('button', { name: 'Retry' }).click();
  await page.waitForSelector('.transfer-details', { timeout: 8000 });
  check(
    'B3 Retry on Transfers loads Transfers (same tab, no load error left)',
    (await loadError(page).count()) === 0 && page.url().endsWith('?tab=transfers'),
    page.url(),
  );
  check('B3 no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
});

// B11: a banner left by a failed dashboard read goes with the next successful read (asked again
// 5 s after a failed one). The operator's Refresh is a read whose failure is shown as the banner.
await run('B11', async () => {
  const { ctx, page, errors } = await open('marta');
  await page.goto(URL);
  await page.waitForSelector('.page-heading');
  await page.route('**/api/dashboard', stub);
  await page.getByRole('button', { name: 'Refresh' }).first().click();
  const banner = page.locator('main > .alert.error');
  await banner.waitFor({ timeout: 8000 });
  check('B11 a failed read shows the banner', (await banner.innerText()).includes(DOWN));
  await page.waitForTimeout(6000);
  check('B11 the banner stays while the read still fails', (await banner.count()) === 1);
  await page.unroute('**/api/dashboard', stub);
  const gone = await banner.waitFor({ state: 'detached', timeout: 9000 }).then(
    () => true,
    () => false,
  );
  check('B11 the banner is gone after the next successful read, with no click', gone);
  check('B11 no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
});

await run('A24g', async () => {
  const { ctx, page, errors } = await open('lucia');
  const r = await page.goto(`${URL}/nope`);
  const h = r.headers();
  check('A24g an unknown address answers 404', r.status() === 404, `${r.status()}`);
  check(
    'A24g the 404 keeps the page security headers',
    /'nonce-[^']+'/.test(h['content-security-policy']) && h['x-frame-options'] === 'DENY',
  );
  check(
    'A24g the page is branded and says so',
    (await page.locator('.not-found .brand-name').count()) === 1 &&
      (await page.getByRole('heading', { name: 'This page does not exist.' }).count()) === 1,
  );
  await page.getByRole('link', { name: 'Back to Overview' }).click();
  await page.waitForSelector('.account-card', { timeout: 8000 });
  check(
    'A24g "Back to Overview" opens the Overview',
    new globalThis.URL(page.url()).pathname === '/',
  );
  check('A24g no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
});

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} check(s) failed` : '\nAll shell-resilience checks passed');
process.exit(failed ? 1 : 0);
