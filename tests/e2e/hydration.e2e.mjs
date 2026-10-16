// Hydration: the first load and a reload produce no hydration error, with fresh storage, with a
// remembered customer or operator, with a browser timezone/locale different from the server's,
// and with an extension that marks <html>/<body> before React loads (as Dark Reader does).
// Run: APP_URL=http://127.0.0.1:3900 node tests/e2e/hydration.e2e.mjs
// Playwright setup and overrides (PLAYWRIGHT_MODULE, PLAYWRIGHT_CHANNEL): README "End-to-end checks".
import { APP_URL as URL, launch } from './env.mjs';
const browser = await launch();
// Production builds log hydration failures only as minified React errors 418/423/425.
const HYDRATION = /hydrat|did not match|server rendered HTML|error #(418|423|425)/i;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function scenario(name, { person, context = {}, init } = {}) {
  const ctx = await browser.newContext(context);
  if (person) await ctx.addInitScript((id) => localStorage.setItem('banana_person', id), person);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    for (const step of ['first load', 'reload']) {
      errors.length = 0;
      if (step === 'first load') await page.goto(URL);
      else await page.reload();
      await page.waitForSelector('select[aria-label="Switch person"]:not([disabled])');
      await page.waitForLoadState('networkidle');
      const hydration = errors.filter((e) => HYDRATION.test(e));
      check(`${name}: ${step}`, hydration.length === 0, hydration.join(' | ').slice(0, 300));
    }
  } catch (e) {
    check(name, false, `threw: ${e.message.split('\n')[0]}`);
  }
  await ctx.close();
}

await scenario('fresh storage');
await scenario('remembered customer', { person: 'lucia' });
await scenario('remembered operator', { person: 'marta' });
await scenario('other timezone and locale', {
  person: 'lucia',
  context: { timezoneId: 'America/New_York', locale: 'es-ES' },
});
await scenario('extension marks <html>/<body>', {
  // What Dark Reader and similar extensions do before React hydrates.
  init: () =>
    new MutationObserver((_, obs) => {
      if (!document.body) return;
      document.documentElement.setAttribute('data-darkreader-mode', 'dynamic');
      document.documentElement.style.colorScheme = 'dark';
      document.body.setAttribute('data-new-gr-c-s-check-loaded', '14.0');
      obs.disconnect();
    }).observe(document, { childList: true, subtree: true }),
});

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll hydration checks passed');
process.exit(failed ? 1 : 0);
