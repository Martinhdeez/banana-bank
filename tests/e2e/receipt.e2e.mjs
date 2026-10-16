// CF1-ui: a completed transfer has a "Receipt" link in "Your transfers" that opens a printable
// receipt page with the API's fields; another customer gets "Transfer not found."; the page has no
// horizontal scroll at 390 px; print media hides the buttons and links. Console stays clean (no
// CSP violations, no hydration warnings). No model calls. The bank scenario is set to "normal"
// for the run and restored to "intermittent 17" after.
//
// Run (production build already running):
//   APP_URL=http://127.0.0.1:3900 BANK_URL=http://127.0.0.1:4901 node tests/e2e/receipt.e2e.mjs
// PLAYWRIGHT_MODULE, PLAYWRIGHT_CHANNEL: README "End-to-end checks". SHOTS: screenshot folder.
import { APP_URL as URL, launch, SHOTS, requireBankUrl } from './env.mjs';
const BANK = requireBankUrl();
const ADMIN = process.env.BANK_ADMIN_SECRET || 'banana-local-admin';
const LABEL = process.env.LABEL || 'run';
const browser = await launch();
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const scenario = (profile, seed = 17) =>
  fetch(`${BANK}/admin/scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ profile, seed }),
  });
const tag = Date.now().toString(36);
const concept = `Receipt ${tag}`;

async function open(persona, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.request.post(`${URL}/api/session`, { data: { userId: persona } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((p) => localStorage.setItem('banana_person', p), persona);
  return { ctx, page, errors };
}

await scenario('normal');
try {
  // A completed transfer: propose, then confirm (the only execution path).
  const { ctx, page, errors } = await open('lucia');
  const proposal = await (
    await ctx.request.post(`${URL}/api/actions`, {
      data: {
        name: 'transfer_money',
        arguments: {
          fromAccountId: 'acc-lucia',
          toAccountId: 'acc-carla',
          amountCents: 110,
          concept,
        },
        intentId: `rc-${tag}`,
      },
    })
  ).json();
  const done = await (
    await ctx.request.post(`${URL}/api/approvals/${proposal.approval?.id}/confirm`, { data: {} })
  ).json();
  check('transfer completed', done.status === 'completed', JSON.stringify(done).slice(0, 160));
  // T7: the stored id is the client id scoped to the user ("lucia:rc-…").
  const id = done.intentId;
  const receiptPath = `/receipt/${encodeURIComponent(id)}`;
  const api = await (
    await ctx.request.get(`${URL}/api/transfers/${encodeURIComponent(id)}/receipt`)
  ).json();

  // The link in "Your transfers".
  await page.goto(`${URL}/?tab=transfers`);
  const row = page.locator('.transfer-item', { hasText: concept });
  await row.waitFor({ timeout: 10000 });
  const link = row.getByRole('link', { name: 'Receipt' });
  const href = (await link.count()) ? await link.getAttribute('href') : null;
  check('row has a "Receipt" link to /receipt/<id>', href === receiptPath, String(href));
  const target = href && (await link.getAttribute('target'));
  await row.screenshot({ path: `${SHOTS}/transfers-row-link-${LABEL}.png` });
  check('link opens in a new tab', target === '_blank', String(target));
  // A proposal never sent has no link (it is in "Your transfers" as pending confirmation).
  const unsentConcept = `Unsent ${tag}`;
  await ctx.request.post(`${URL}/api/actions`, {
    data: {
      name: 'transfer_money',
      arguments: {
        fromAccountId: 'acc-lucia',
        toAccountId: 'acc-carla',
        amountCents: 120,
        concept: unsentConcept,
      },
      intentId: `ru-${tag}`,
    },
  });
  await page.reload();
  const unsent = page.locator('.transfer-item', { hasText: unsentConcept });
  await unsent.waitFor({ timeout: 10000 });
  check(
    'unsent proposal has no Receipt link',
    (await unsent.getByRole('link', { name: 'Receipt' }).count()) === 0,
  );

  // The receipt page.
  await page.goto(`${URL}${receiptPath}`);
  await page.locator('main dt, main [role=alert]').first().waitFor({ timeout: 10000 });
  const h1 = await page.getByRole('heading', { level: 1 }).innerText();
  check('h1 "Transfer receipt"', h1 === 'Transfer receipt', h1);
  const title = await page.title();
  check('document title', /Transfer receipt/.test(title), title);
  const dd = async (term) => {
    const dt = page.locator('dt', { hasText: new RegExp(`^${term}$`) });
    return (await dt.count())
      ? (await dt.locator('xpath=following-sibling::dd[1]').innerText()).trim()
      : '';
  };
  const fields = {
    Reference: await dd('Reference'),
    Status: await dd('Status'),
    Amount: await dd('Amount'),
    From: await dd('From'),
    To: await dd('To'),
    Description: await dd('Description'),
    Verified: await dd('Verified'),
  };
  check(
    'reference matches the API',
    !!api.reference && fields.Reference.includes(api.reference),
    fields.Reference,
  );
  check('status completed', /Completed by the bank/.test(fields.Status), fields.Status);
  check('amount €1.10', fields.Amount === '€1.10', fields.Amount);
  check('from Lucía account', fields.From.includes(api.from?.label ?? '?'), fields.From);
  check('to Carla Ríos', fields.To.includes('Carla Ríos'), fields.To);
  check('description', fields.Description === concept, fields.Description);
  check('verified time shown', /\d{4}/.test(fields.Verified), fields.Verified);
  check(
    'print button',
    (await page.getByRole('button', { name: 'Print or save as PDF' }).count()) === 1,
  );
  check(
    'back link',
    (await page.getByRole('link', { name: 'Back to transfers' }).getAttribute('href')) ===
      '/?tab=transfers',
  );
  check('no app chrome (sidebar, topbar)', (await page.locator('.sidebar, .topbar').count()) === 0);
  await page.screenshot({ path: `${SHOTS}/receipt-1280-${LABEL}.png`, fullPage: true });

  // Print media: buttons and links hidden.
  await page.emulateMedia({ media: 'print' });
  const visibleControls = await page.evaluate(
    () => [...document.querySelectorAll('button, a')].filter((el) => el.checkVisibility()).length,
  );
  check('print hides buttons and links', visibleControls === 0, `${visibleControls} visible`);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('print background is white', bg === 'rgb(255, 255, 255)', bg);
  await page.screenshot({ path: `${SHOTS}/receipt-print-${LABEL}.png`, fullPage: true });
  await page.emulateMedia({ media: 'screen' });

  // 390 px: no horizontal scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 10000 });
  await page.locator('dt', { hasText: /^Reference$/ }).waitFor();
  const scroll = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  check(
    'no horizontal scroll at 390',
    scroll[0] <= scroll[1],
    `scrollWidth ${scroll[0]}, clientWidth ${scroll[1]}`,
  );
  await page.screenshot({ path: `${SHOTS}/receipt-390-${LABEL}.png`, fullPage: true });

  check(
    'console clean (no CSP, hydration or other errors)',
    errors.length === 0,
    errors.join(' | ').slice(0, 300),
  );
  await ctx.close();

  // Another customer: the API's 404 text, no receipt fields.
  const other = await open('bruno');
  await other.page.goto(`${URL}${receiptPath}`);
  const alert = other.page.locator('main').getByRole('alert');
  await alert.waitFor({ timeout: 10000 }).catch(() => {});
  const text = (await alert.count()) ? await alert.innerText() : '';
  check('another customer sees "Transfer not found."', /Transfer not found\./.test(text), text);
  check(
    'another customer sees no reference',
    !(await other.page.content()).includes(api.reference ?? '§'),
  );
  await other.ctx.close();

  // Review: the other API answers, each shown as its plain text, and the non-final version. A real
  // pending receipt is hard to hold (the receipt re-verifies with the bank and finds the
  // operation), so the completed receipt's body is served as pending_verification.
  const again = await open('lucia');
  const alertText = async (p) => {
    const a = p.locator('main').getByRole('alert');
    await a.waitFor({ timeout: 10000 }).catch(() => {});
    return (await a.count()) ? await a.innerText() : '';
  };
  await again.page.goto(`${URL}/receipt/${encodeURIComponent(`lucia:ru-${tag}`)}`);
  const never = await alertText(again.page);
  check(
    'unsent transfer shows the 409 text',
    /was never sent, so there is no receipt/.test(never),
    never,
  );
  await again.page.route('**/api/transfers/*/receipt', async (route) => {
    const body = await (await route.fetch()).json();
    await route.fulfill({
      json: { ...body, status: 'pending_verification', final: false, verifiedAt: null },
    });
  });
  await again.page.goto(`${URL}${receiptPath}`);
  await again.page.locator('dt', { hasText: /^Reference$/ }).waitFor({ timeout: 10000 });
  const pendingH1 = await again.page.getByRole('heading', { level: 1 }).innerText();
  check('non-final heading', pendingH1 === 'Transfer record (not final)', pendingH1);
  check(
    'non-final banner',
    (await again.page.getByRole('note').innerText()).includes('This is not proof of payment.'),
  );
  // The 409 fetch is logged by the browser as a failed resource; anything else is a failure.
  const reviewErrors = again.errors.filter((e) => !/status of 409/.test(e));
  check(
    'review pages console clean',
    reviewErrors.length === 0,
    reviewErrors.join(' | ').slice(0, 300),
  );
  await again.ctx.close();
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(`${URL}${receiptPath}`);
  const signedOut = await alertText(anonPage);
  check(
    'no session shows the 401 text',
    /Select a person to continue\./.test(signedOut),
    signedOut,
  );
  await anon.close();
} catch (e) {
  check('receipt flow', false, `threw: ${e.message.split('\n')[0]}`);
} finally {
  await scenario('intermittent', 17);
  await browser.close();
}
process.exit(failed ? 1 : 0);
