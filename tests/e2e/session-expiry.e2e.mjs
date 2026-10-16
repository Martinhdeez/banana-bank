// SEC3: an expired or pre-SEC3 session cookie never breaks the page. On load the remembered person
// is selected again (D6); a session that expires while the page is open sends it back to person
// selection (LoadError with the server's message), and Retry or the person picker recovers.
// Run: APP_URL=http://127.0.0.1:3800 node tests/e2e/session-expiry.e2e.mjs (default SESSION_SECRET)
// Playwright setup and overrides (PLAYWRIGHT_MODULE, PLAYWRIGHT_CHANNEL): README "End-to-end checks".
import { createHmac } from 'node:crypto';
import { APP_URL as URL, launch, SHOTS } from './env.mjs';
const SECRET = process.env.SESSION_SECRET || 'banana-local-session';
const browser = await launch();
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sign = (v) => createHmac('sha256', SECRET).update(v).digest('hex');
const v1 = `lucia.${sign('lucia')}`;
const old = `lucia.${Math.floor(Date.now() / 1000) - 43201}`;
const expiredV2 = `${old}.${sign(old)}`;
const expiredText = 'Your session expired. Select a person again.';
const host = new globalThis.URL(URL).hostname;
const setCookie = (ctx, value) =>
  ctx.addCookies([{ name: 'banana_actor', value, domain: host, path: '/', httpOnly: true }]);
const actorCookie = async (ctx) =>
  (await ctx.cookies()).find((c) => c.name === 'banana_actor')?.value || '';

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(() => localStorage.setItem('banana_person', 'lucia'));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}

try {
  const { ctx, page, errors } = await open();
  await setCookie(ctx, v1);
  await page.goto(URL);
  await page.waitForSelector('.assistant-card');
  const cookie = await actorCookie(ctx);
  check('a pre-SEC3 cookie on load: the dashboard loads', !(await page.$('.load-error')));
  check('the cookie is replaced by a v2 token', cookie.split('.').length === 3, cookie);
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) {
  check('pre-SEC3 cookie on load', false, `threw: ${e.message.split('\n')[0]}`);
}

try {
  const { ctx, page, errors } = await open();
  await page.goto(URL);
  await page.waitForSelector('.assistant-card');
  // The session expires while the page is open; the next read (opening Transfers) gets 401.
  await setCookie(ctx, expiredV2);
  await page.locator('nav[aria-label="Sections"] .nav-item', { hasText: 'Transfers' }).click();
  const alert = page.locator('.load-error');
  await alert.waitFor({ timeout: 10000 });
  const text = await alert.innerText();
  check('an expired session returns to person selection', text.includes(expiredText), text);
  check(
    'the person picker stays usable',
    await page.locator('select[aria-label="Switch person"]').isEnabled(),
  );
  await page.screenshot({ path: `${SHOTS}/sec3-expired.png` });
  await alert.getByRole('button', { name: 'Retry' }).click();
  await page.waitForSelector('.load-error', { state: 'detached' });
  await page.waitForSelector('nav[aria-label="Sections"] .nav-item.active');
  const cookie = await actorCookie(ctx);
  check('Retry selects the person again with a fresh token', cookie !== expiredV2, cookie);
  // Switching person also recovers.
  await setCookie(ctx, expiredV2);
  await page.goto(URL);
  await page.waitForSelector('.assistant-card');
  await setCookie(ctx, v1);
  await page.locator('nav[aria-label="Sections"] .nav-item', { hasText: 'Transfers' }).click();
  await alert.waitFor({ timeout: 10000 });
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/session') && r.status() === 200),
    page.locator('select[aria-label="Switch person"]').selectOption('bruno'),
  ]);
  await page.waitForSelector('.assistant-card');
  check('the person picker recovers', (await actorCookie(ctx)).startsWith('bruno.'));
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
} catch (e) {
  check('expired while open', false, `threw: ${e.message.split('\n')[0]}`);
}

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll session-expiry checks passed');
process.exit(failed ? 1 : 0);
