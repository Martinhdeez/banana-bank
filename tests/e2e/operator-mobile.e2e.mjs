// O5: on a phone (390x844), opening a case or a document brings the detail/reader into view and
// moves focus to it; the documents search query does not survive a persona switch.
// No model or embeddings calls. Run against a running app:
//   APP_URL=http://127.0.0.1:3800 node tests/e2e/operator-mobile.e2e.mjs
// Playwright setup and overrides (PLAYWRIGHT_MODULE, PLAYWRIGHT_CHANNEL): README "End-to-end checks".
import { APP_URL as URL, launch, requireSeed } from './env.mjs';
await requireSeed(URL);
const browser = await launch();
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
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
// Top of the element in the upper half of the viewport, and the element (or something inside it) focused.
const revealed = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const top = el.getBoundingClientRect().top;
    return {
      inView: top >= 0 && top < window.innerHeight / 2,
      focused: el.contains(document.activeElement),
      top: Math.round(top),
    };
  }, selector);
const nav = (page, label) => page.locator('nav button', { hasText: label }).first().click();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
await page.goto(URL);
try {
  await switchTo(page, 'marta');
  await Promise.all([
    page.waitForResponse((r) => /\/api\/incidents\/[^/]+$/.test(r.url())),
    page.locator('.case-item').nth(2).click(),
  ]);
  await pause(400);
  const c = await revealed(page, '.case-detail');
  check('O5 case detail scrolled into view', c.inView, `top=${c.top}`);
  check('O5 case detail receives focus', c.focused);

  await nav(page, 'Documents');
  await page.waitForSelector('.document-list button');
  await page.evaluate(() => window.scrollTo(0, 0));
  await Promise.all([
    page.waitForResponse((r) => /\/api\/documents\/[^/]+$/.test(r.url())),
    page.locator('.document-list button').nth(1).click(),
  ]);
  await pause(400);
  const d = await revealed(page, '.document-reader');
  check('O5 document reader scrolled into view', d.inView, `top=${d.top}`);
  check('O5 document reader receives focus', d.focused);

  await page.getByLabel('Search documents').fill('internal escalation procedure');
  await switchTo(page, 'lucia');
  await nav(page, 'Documents');
  const q = await page.getByLabel('Search documents').inputValue();
  check('O5 search query cleared on persona switch', q === '', JSON.stringify(q));
} catch (e) {
  check('O5 run', false, `threw: ${e.message.split('\n')[0]}`);
}
await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
