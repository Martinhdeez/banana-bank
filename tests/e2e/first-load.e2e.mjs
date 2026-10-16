// D6: a first visit (no cookie) loads without console errors or failed requests, the icon
// resolves, and the overview assistant card text is not covered or clipped at 390 px.
// Run: APP_URL=http://127.0.0.1:3900 node tests/e2e/first-load.e2e.mjs
// Playwright setup and overrides (PLAYWRIGHT_MODULE, PLAYWRIGHT_CHANNEL): README "End-to-end checks".
import { APP_URL as URL, launch, SHOTS } from './env.mjs';
const browser = await launch();
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function firstLoad(viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [],
    bad = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on(
    'response',
    (r) => r.status() >= 400 && bad.push(`${r.status()} ${new globalThis.URL(r.url()).pathname}`),
  );
  await page.goto(URL);
  await page.waitForSelector('.assistant-card');
  await page.waitForLoadState('networkidle');
  return { ctx, page, errors, bad };
}

try {
  const { ctx, page, errors, bad } = await firstLoad({ width: 1400, height: 900 });
  const h = (await page.request.get(URL)).headers(); // SEC2: page CSP carries a nonce; framing denied.
  check(
    'security headers on the page',
    /'nonce-[^']+'/.test(h['content-security-policy']) && h['x-frame-options'] === 'DENY',
    JSON.stringify([h['content-security-policy'], h['x-frame-options']]),
  );
  check('no console errors on first load', errors.length === 0, errors.join(' | '));
  check('no 4xx/5xx responses on first load', bad.length === 0, bad.join(', '));
  check('no favicon 404', !bad.some((b) => /favicon|icon/.test(b)));
  const href = await page.evaluate(() => document.querySelector('link[rel~="icon"]')?.href);
  const icon = href ? (await page.request.get(href)).status() : 0;
  check(
    'page declares an icon that loads',
    icon === 200,
    href ? `${icon} ${href}` : 'no <link rel=icon>',
  );
  await ctx.close();
} catch (e) {
  check('desktop first load', false, `threw: ${e.message.split('\n')[0]}`);
}

try {
  const { ctx, page } = await firstLoad({ width: 390, height: 844 });
  // The decorative rings are the card's ::after circle plus box-shadow spreads. Shadows are not
  // hit-testable, so this is geometry: a text line that reaches the ring area must be stacked
  // above it (positioned with z-index >= 1), otherwise the rings paint over the text. No text line
  // may overflow the card either.
  const report = await page.evaluate(() => {
    const card = document.querySelector('.assistant-card');
    const box = card.getBoundingClientRect();
    const ring = getComputedStyle(card, '::after');
    const border = parseFloat(getComputedStyle(card).borderTopWidth);
    const size = parseFloat(ring.width);
    const spread = Math.max(0, ...[...ring.boxShadow.matchAll(/(-?[\d.]+)px/g)].map((m) => +m[1]));
    const cx = box.right - border - parseFloat(ring.right) - size / 2;
    const cy = box.top + border + parseFloat(ring.top) + size / 2;
    const radius = size / 2 + spread;
    const issues = [];
    for (const el of card.querySelectorAll('h2, p, button')) {
      const style = getComputedStyle(el);
      const above = style.position !== 'static' && parseInt(style.zIndex) >= 1;
      const range = document.createRange();
      range.selectNodeContents(el);
      for (const r of range.getClientRects()) {
        if (r.width < 1) continue;
        if (r.right > box.right + 0.5 || r.left < box.left - 0.5)
          issues.push(`${el.tagName} line overflows the card`);
        const dx = Math.max(r.left - cx, 0, cx - r.right),
          dy = Math.max(r.top - cy, 0, cy - r.bottom);
        if (Math.hypot(dx, dy) < radius && !above)
          issues.push(`${el.tagName} "${el.textContent.trim().slice(0, 30)}" runs under the rings`);
      }
    }
    return issues;
  });
  check(
    'assistant card text not covered or clipped at 390 px',
    report.length === 0,
    [...new Set(report)].join('; '),
  );
  await page.locator('.assistant-card').screenshot({ path: `${SHOTS}/assistant-card-390.png` });
  await ctx.close();
} catch (e) {
  check('mobile assistant card', false, `threw: ${e.message.split('\n')[0]}`);
}

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll first-load checks passed');
process.exit(failed ? 1 : 0);
