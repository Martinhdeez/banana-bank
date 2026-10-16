// Overview and account drawer checks (redesign slice 2, U7 round 4) against a running app. No
// model calls: proposals go through POST /api/actions. The bank scenario is set to "normal" for
// the run and restored to "intermittent 17" after. Leaves pending proposals (they expire).
//
// Run (app and bank already running):
//   APP_URL=http://127.0.0.1:3000 BANK_URL=http://127.0.0.1:4001 node tests/e2e/overview.e2e.mjs
// PLAYWRIGHT_MODULE / PLAYWRIGHT_CHANNEL / SHOTS as in the other e2e scripts.
import { APP_URL as URL, launch, SHOTS, requireBankUrl } from './env.mjs';
const BANK = requireBankUrl();
const ADMIN = process.env.BANK_ADMIN_SECRET || 'banana-local-admin';
const browser = await launch();
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const scenario = (profile, seed = 17) =>
  fetch(`${BANK}/admin/scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ profile, seed }),
  }).catch(() => {});
const tag = Date.now().toString(36);
// Unique amounts per run: an identical pending proposal from an earlier run would be a duplicate.
const cents = 101 + (Date.now() % 800);
const euros = (c) => `€${(c / 100).toFixed(2)}`;

async function open(persona, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.request.post(`${URL}/api/session`, { data: { userId: persona } });
  const page = await ctx.newPage();
  await page.addInitScript((p) => localStorage.setItem('banana_person', p), persona);
  await page.goto(`${URL}/?tab=overview`);
  await page.waitForSelector('.account-card');
  return { ctx, page };
}
async function apiTransfer(ctx, args, confirm = true) {
  const r = await (
    await ctx.request.post(`${URL}/api/actions`, {
      data: { name: 'transfer_money', arguments: args, intentId: `ov-${tag}-${Math.random()}` },
    })
  ).json();
  if (r.status !== 'requires_confirmation') throw new Error(JSON.stringify(r));
  if (confirm)
    await ctx.request.post(`${URL}/api/approvals/${r.approval.id}/confirm`, { data: {} });
  return r;
}
const active = (page) => page.locator('nav button[aria-current="page"]').innerText();
async function run(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name, false, `threw: ${e.message.split('\n')[0]}`);
  }
}

await scenario('normal');

await run('Overview attention', async () => {
  const { ctx, page } = await open('lucia');
  await apiTransfer(
    ctx,
    { fromAccountId: 'acc-lucia', recipient: 'carla', amountCents: cents, concept: `Attn ${tag}` },
    false,
  );
  await page.reload();
  const item = page.locator('.attention-item', { hasText: `Attn ${tag}` });
  await item.waitFor();
  const actions = await page.locator('.attention button').allInnerTexts();
  check(
    'attention lists the proposal without Confirm/Cancel/Approve',
    !actions.some((t) => /Confirm|Cancel|Approve/.test(t)),
    actions.join(' | '),
  );
  const row = (
    await page.locator('.movements .movement.pending', { hasText: `Attn ${tag}` }).innerText()
  ).replace(/\s+/g, ' ');
  check(
    'U7 pending row: badge, unsigned amount, "Not sent yet"',
    /Pending your confirmation/.test(row) &&
      row.includes(euros(cents)) &&
      !row.includes(`-${euros(cents)}`) &&
      /Not sent yet/.test(row),
    row,
  );
  await item.getByRole('button', { name: /Review in Transfers/ }).click();
  check('"Review in Transfers" opens Transfers', /Transfers/.test(await active(page)));
  await ctx.close();
});

await run('Filter', async () => {
  const { ctx, page } = await open('lucia');
  await apiTransfer(ctx, {
    fromAccountId: 'acc-lucia',
    toAccountId: 'acc-lucia-savings',
    amountCents: cents + 1,
    concept: `Filter ${tag}`,
  });
  await page.reload();
  await page.locator('.movements .movement').first().waitFor();
  // Pending proposals are pinned first; "View all" keeps the movement in view however many exist.
  await page.getByRole('button', { name: 'View all' }).click();
  const seg = page.locator('.segmented');
  await seg.getByRole('button', { name: 'Personal savings' }).click();
  const savings = page.locator('.movements .movement', { hasText: `Filter ${tag}` });
  await savings.waitFor();
  const s = (await savings.innerText()).replace(/\s+/g, ' ');
  await seg.getByRole('button', { name: 'Aurora account' }).click();
  const aurora = page.locator('.movements .movement', { hasText: `Filter ${tag}` });
  await aurora.waitFor();
  const a = (await aurora.innerText()).replace(/\s+/g, ' ');
  check(
    'internal move kept under each account filter, signed',
    /Between your accounts/.test(s) &&
      s.includes(`+${euros(cents + 1)}`) &&
      a.includes(`-${euros(cents + 1)}`),
    `${s} | ${a}`,
  );
  const pressed = await seg.locator('button[aria-pressed="true"]').allInnerTexts();
  check('segmented exposes aria-pressed', pressed.join() === 'Aurora account', pressed.join());
  await ctx.close();
});

await run('Drawer', async () => {
  const { ctx, page } = await open('lucia');
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: URL });
  const dash = await page.evaluate(async () => (await fetch('/api/dashboard')).json());
  const acc = dash.accounts[0];
  const raw = acc.iban.replace(/\s+/g, '');
  const grouped = raw.replace(/(.{4})(?=.)/g, '$1 ');
  await page.locator('.account-card').first().click();
  const dialog = page.locator('dialog.account-drawer[open]');
  await dialog.waitFor();
  const text = await dialog.innerText();
  check(
    'drawer shows the full grouped IBAN and the holder',
    text.includes(grouped) && text.includes('Lucía Martín'),
    grouped,
  );
  await dialog.getByRole('button', { name: 'Copy IBAN' }).click();
  await dialog.getByRole('status').filter({ hasText: 'Copied' }).waitFor({ timeout: 3000 });
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check('"Copy IBAN" copies the raw IBAN and says so', clip === raw, clip);
  await page.keyboard.press('Escape');
  await page
    .locator('dialog.account-drawer[open]')
    .waitFor({ state: 'detached', timeout: 3000 })
    .catch(() => {});
  check('Esc closes the drawer', (await page.locator('dialog.account-drawer[open]').count()) === 0);
  const savings = dash.accounts.find((a) => /savings/i.test(a.label));
  await page.getByRole('button', { name: `${savings.label} details` }).click();
  await dialog.getByRole('button', { name: 'Transfer from here' }).click();
  await page.locator('.transfer-form').waitFor();
  const from = await page.locator('.transfer-form input[name="from"]:checked').inputValue();
  check(
    '"Transfer from here" opens Transfers with that source',
    /Transfers/.test(await active(page)) && from === savings.id,
    from,
  );
  await ctx.close();
});

await run('Recipients', async () => {
  const { ctx, page } = await open('lucia');
  await page.locator('.recipients .recipient', { hasText: 'Carla' }).click();
  await page.locator('.transfer-form').waitFor();
  const to = await page.getByLabel('Recipient', { exact: true }).inputValue();
  check(
    'a recipient opens the transfer form with that person',
    /Transfers/.test(await active(page)) && to === 'carla',
    to,
  );
  await ctx.close();
});

await run('Mobile sheet', async () => {
  const { ctx, page } = await open('lucia', { width: 390, height: 844 });
  await page.locator('.account-card').first().click();
  const dialog = page.locator('dialog.account-drawer[open]');
  await dialog.waitFor();
  await page.waitForTimeout(300);
  const box = await dialog.boundingBox();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  check(
    '390 px: bottom sheet sits on the bottom edge, no horizontal scroll',
    Math.abs(box.y + box.height - 844) <= 1 && width <= 390,
    `bottom=${box.y + box.height} scrollWidth=${width}`,
  );
  await page.screenshot({ path: `${SHOTS}/e2e-sheet-390.png` });
  await ctx.close();
});

await scenario('intermittent', 17);
await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
