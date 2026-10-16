// Behaviour checks for R1–R8 and the Recent activity card against a running app. No model calls:
// proposals go through POST /api/actions or the transfer form. The bank scenario is set to
// "normal" for the run and restored to "intermittent 17" after.
//
// Run (app and bank already running):
//   APP_URL=http://127.0.0.1:3000 BANK_URL=http://127.0.0.1:4001 node tests/e2e/transfer-recipients.e2e.mjs
// PLAYWRIGHT_MODULE, PLAYWRIGHT_CHANNEL, SHOTS: README "End-to-end checks". LABEL: a suffix for
// the screenshot names.
import { APP_URL as URL, launch, SHOTS, requireBankUrl } from './env.mjs';
const BANK = requireBankUrl();
const ADMIN = process.env.BANK_ADMIN_SECRET || 'banana-local-admin';
const LABEL = process.env.LABEL || 'run';
const browser = await launch();
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
// R8's timeline needs the `normal` scenario: under `intermittent 17` a lost response adds a
// "sent again" step. A scenario call that fails must stop the run, not be ignored.
const scenario = async (profile, seed = 17) => {
  const r = await fetch(`${BANK}/admin/scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ profile, seed }),
  });
  if (!r.ok)
    throw new Error(
      `bank scenario ${profile}: HTTP ${r.status} (check BANK_URL and BANK_ADMIN_SECRET)`,
    );
};
const tag = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(persona, viewport = { width: 1366, height: 768 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.request.post(`${URL}/api/session`, { data: { userId: persona } });
  const page = await ctx.newPage();
  await page.addInitScript((p) => localStorage.setItem('banana_person', p), persona);
  await page.goto(URL);
  await page.waitForSelector('.page-heading');
  return { ctx, page };
}
const nav = (page, label) => page.locator('nav button', { hasText: label }).click();
const rows = (page) => page.locator('.movements .movement');
const rowTexts = async (page) =>
  (await rows(page).allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));
async function apiTransfer(ctx, args, confirm = true) {
  const r = await (
    await ctx.request.post(`${URL}/api/actions`, {
      data: { name: 'transfer_money', arguments: args, intentId: `e2e-${tag}-${Math.random()}` },
    })
  ).json();
  if (r.status !== 'requires_confirmation') throw new Error(JSON.stringify(r));
  if (confirm)
    await ctx.request.post(`${URL}/api/approvals/${r.approval.id}/confirm`, { data: {} });
  return r;
}
async function run(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name, false, `threw: ${e.message.split('\n')[0]}`);
  }
}

await scenario('normal');
try {
  // R1 + R2: review button, recipients by person, pending proposal in view and focused.
  await run('R1/R2', async () => {
    const { ctx, page } = await open('hugo');
    await nav(page, 'Transfers');
    const form = page.locator('.transfer-form');
    const button = (await form.locator('button.primary-button').innerText()).trim();
    check('R1 form button reads "Review transfer"', button === 'Review transfer', button);
    const people = await form
      .getByLabel('Recipient', { exact: true })
      .locator('option')
      .allInnerTexts();
    const named = people.filter((p) => !/Select/.test(p));
    check(
      'R2 one recipient option per person',
      named.length === new Set(named).size &&
        named.includes('Carla Ríos') &&
        !named.some((p) => /·|acc-/.test(p)),
      named.join(' | '),
    );
    await form.getByLabel('Recipient', { exact: true }).selectOption({ label: 'Carla Ríos' });
    const account = form.getByLabel('Recipient account');
    const main = (await account.count()) ? await account.inputValue() : '';
    const accountOptions = (await account.count())
      ? await account.locator('option').allInnerTexts()
      : [];
    check(
      'R2 recipient account defaults to the main account',
      main === 'acc-carla',
      `${main} [${accountOptions.join(' | ')}]`,
    );
    await form.getByLabel('Recipient', { exact: true }).selectOption({ label: 'Bruno Vidal' });
    check('R2 no account choice for a one-account person', (await account.count()) === 0);
    await form.getByLabel('Recipient', { exact: true }).selectOption({ label: 'Carla Ríos' });
    await page.getByLabel('Amount in euros').fill('1.23');
    await form.getByPlaceholder('What is this transfer for?').fill(`R1 ${tag}`);
    await form.locator('button.primary-button').click();
    const proposal = page.locator('.approvals .proposal', { hasText: `R1 ${tag}` });
    await proposal.waitFor({ timeout: 8000 });
    await sleep(300);
    const box = await proposal.boundingBox();
    const inView = !!box && box.y >= 0 && box.y + box.height <= 768;
    const focused = await page.evaluate(
      () => !!document.activeElement?.closest('.approvals .proposal'),
    );
    check(
      'R1 new proposal scrolled into view (1366×768) and focused',
      inView && focused,
      `inView=${inView} focused=${focused} y=${box?.y}`,
    );
    const text = await proposal.innerText();
    check('R1 proposal marked "Pending your confirmation"', /Pending your confirmation/.test(text));
    check(
      'R2 proposal shows the exact destination account',
      /Carla Ríos · Aurora account/.test(text),
      text.split('\n')[1],
    );
    const successBanner = await page.locator('main > .alert.notice').count();
    check('R1 no success-style banner for a proposal', successBanner === 0);
    const [pendingBg, completedBg] = await page.evaluate(() => {
      const p = document.querySelector('.approvals .proposal');
      const probe = document.createElement('div');
      probe.className = 'alert notice';
      document.body.append(probe);
      const out = [getComputedStyle(p).backgroundColor, getComputedStyle(probe).backgroundColor];
      probe.remove();
      return out;
    });
    check(
      'R1 pending style differs from the completed style',
      pendingBg !== completedBg,
      `${pendingBg} vs ${completedBg}`,
    );
    await page.screenshot({ path: `${SHOTS}/r1-proposal-in-view-${LABEL}.png` });
    // R3: the proposal also leads Recent activity as pending.
    await nav(page, 'Overview');
    await rows(page).first().waitFor();
    const first = (await rowTexts(page))[0] ?? '';
    check(
      'R3 pending proposal first in Recent activity',
      /Pending your confirmation/.test(first) && first.includes(`R1 ${tag}`),
      first,
    );
    await page.screenshot({ path: `${SHOTS}/r3-activity-pending-${LABEL}.png` });
    // R5: cancel it from the panel.
    await nav(page, 'Transfers');
    await proposal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await proposal.waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
    const result = await page
      .locator('.approvals .confirm-result')
      .innerText()
      .catch(() => '');
    check(
      'R5 cancel removes the proposal and says no money moved',
      (await proposal.count()) === 0 && /No money moved/.test(result),
      result,
    );
    // R8: its timeline says proposed → cancelled, nothing else.
    const item = page.locator('.transfer-item', { hasText: `R1 ${tag}` });
    const steps = await item
      .locator('.timeline li')
      .allInnerTexts()
      .catch(() => []);
    check(
      'R8 cancelled transfer timeline: proposed, cancelled',
      steps.length === 2 && /Proposed/.test(steps[0]) && /Cancelled/.test(steps[1]),
      steps.join(' | ').replace(/\n/g, ' '),
    );
    await ctx.close();
  });

  // R4/R8 + refresh: carla sends to hugo through the UI; both activity lists update with names,
  // hugo's without a page reload; the timeline shows each recorded step.
  await run('R4 refresh', async () => {
    const { ctx, page } = await open('carla');
    await nav(page, 'Transfers');
    const form = page.locator('.transfer-form');
    await form.getByLabel('Recipient', { exact: true }).selectOption({ label: 'Hugo Pérez' });
    await page.getByLabel('Amount in euros').fill('2.34');
    await form.getByPlaceholder('What is this transfer for?').fill(`R4 ${tag}`);
    await form.locator('button.primary-button').click();
    const proposal = page.locator('.approvals .proposal', { hasText: `R4 ${tag}` });
    await proposal.getByRole('button', { name: /Confirm/ }).click();
    await page.locator('.approvals .confirm-result').waitFor({ timeout: 8000 });
    const item = page.locator('.transfer-item', { hasText: `R4 ${tag}` });
    await item
      .locator('.timeline li', { hasText: 'Completed by the bank' })
      .waitFor({ timeout: 8000 })
      .catch(() => {});
    const steps = (await item.locator('.timeline li span').allInnerTexts()).join(' → ');
    check(
      'R8 confirmed transfer timeline',
      /^Proposed for your review → Confirmed by you → Sent to the bank → Completed by the bank$/.test(
        steps,
      ),
      steps,
    );
    await item.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/r8-timeline-${LABEL}.png` });
    await nav(page, 'Overview');
    await rows(page).first().waitFor();
    const mine = (await rowTexts(page)).find((t) => t.includes(`R4 ${tag}`)) ?? '';
    check(
      'R4 sender row: "Sent to Hugo Pérez", concept, account',
      /Sent to Hugo Pérez/.test(mine) &&
        mine.includes(`R4 ${tag}`) &&
        /Aurora account/.test(mine) &&
        /-€2\.34/.test(mine),
      mine,
    );
    await page.getByLabel('Switch person').selectOption('hugo');
    await page.waitForFunction(() =>
      document.querySelector('.page-heading h1')?.textContent?.includes('Hugo'),
    );
    await rows(page).first().waitFor();
    const theirs = (await rowTexts(page)).find((t) => t.includes(`R4 ${tag}`)) ?? '';
    check(
      'R4 recipient sees "Received from Carla Ríos" after a persona switch, no reload',
      /Received from Carla Ríos/.test(theirs) &&
        theirs.includes(`R4 ${tag}`) &&
        /\+€2\.34/.test(theirs),
      theirs,
    );
    await page.screenshot({ path: `${SHOTS}/r4-recipient-activity-${LABEL}.png` });
    // Another person pays hugo while his overview is open: it appears without a reload.
    const carla = await browser.newContext();
    await carla.request.post(`${URL}/api/session`, { data: { userId: 'carla' } });
    await apiTransfer(carla, {
      fromAccountId: 'acc-carla',
      recipient: 'hugo',
      amountCents: 345,
      concept: `Live ${tag}`,
    });
    await carla.close();
    const started = Date.now();
    let seen = false;
    while (!seen && Date.now() - started < 30_000) {
      seen = (await rowTexts(page)).some((t) => t.includes(`Live ${tag}`));
      if (!seen) await sleep(1000);
    }
    check(
      'R4 an incoming credit appears on an open overview without a reload',
      seen,
      `${Math.round((Date.now() - started) / 1000)} s`,
    );
    await ctx.close();
  });

  // R4: an internal move shows once; "View all" shows more than 7; newest first.
  await run('R4 list', async () => {
    const { ctx, page } = await open('lucia');
    await apiTransfer(ctx, {
      fromAccountId: 'acc-lucia',
      toAccountId: 'acc-lucia-savings',
      amountCents: 111,
      concept: `Internal ${tag}`,
    });
    await page.reload();
    await rows(page).first().waitFor();
    const pinned = await page
      .locator('.movements .movement.pending, .movements .movement.verifying')
      .count();
    const before = await rows(page).count();
    await page.getByRole('button', { name: 'View all' }).click();
    const all = await rows(page).count();
    check(
      'R4 "View all" shows more than 7 movements',
      before === Math.max(7, pinned) && all - pinned > 7,
      `${before} → ${all} (${pinned} pending)`,
    );
    const internal = (await rowTexts(page)).filter((t) => t.includes(`Internal ${tag}`));
    check(
      'R4 a move between own accounts is one row',
      internal.length === 1 && /Between your accounts/.test(internal[0]),
      internal.join(' | '),
    );
    const dates = await page.evaluate(async () =>
      (await (await fetch('/api/dashboard')).json()).movements.map((m) => m.createdAt),
    );
    check('R4 movements newest first', dates.join() === [...dates].sort().reverse().join());
    await page.screenshot({ path: `${SHOTS}/r4-view-all-${LABEL}.png`, fullPage: true });
    await ctx.close();
  });

  // R6: the outcome line is stored in the conversation (see also X2 in transfer-experience).
  await run('R6', async () => {
    const { ctx, page } = await open('bruno');
    const conv = await (await ctx.request.post(`${URL}/api/conversations`, { data: {} })).json();
    const r = await (
      await ctx.request.post(`${URL}/api/actions`, {
        data: {
          name: 'transfer_money',
          arguments: {
            fromAccountId: 'acc-bruno',
            recipient: 'Carla',
            amountCents: 150,
            concept: `R6 ${tag}`,
          },
          intentId: `r6-${tag}`,
          conversationId: conv.id,
        },
      })
    ).json();
    await ctx.request.post(`${URL}/api/approvals/${r.approval.id}/confirm`, { data: {} });
    const other = await open('bruno');
    await nav(other.page, 'Assistant');
    await other.page.getByLabel('Conversation', { exact: true }).selectOption(conv.id);
    const line = other.page.locator('.message .outcome', { hasText: `R6 ${tag}` });
    await line.waitFor({ timeout: 8000 }).catch(() => {});
    const text = (await line.count()) ? await line.innerText() : '';
    check(
      'R6 outcome stored server-side, shown in another browser',
      /Carla Ríos · Aurora account .*Transfer completed/.test(text),
      text || 'no line',
    );
    await other.page.screenshot({ path: `${SHOTS}/r6-chat-outcome-${LABEL}.png` });
    await other.ctx.close();
    await ctx.close();
  });
} finally {
  // Rerunnable without `npm run reset`: cancel any proposal of this run still pending (e.g. R1's
  // when a check threw before its cancel), so later runs never see it in their lists.
  for (const persona of ['hugo', 'carla', 'lucia', 'bruno']) {
    const ctx = await browser.newContext();
    await ctx.request.post(`${URL}/api/session`, { data: { userId: persona } });
    const { approvals = [] } = await (await ctx.request.get(`${URL}/api/dashboard`)).json();
    for (const a of approvals.filter((a) => a.payload?.concept?.includes(tag)))
      await ctx.request.post(`${URL}/api/approvals/${a.id}/cancel`, { data: {} });
    await ctx.close();
  }
  await scenario('intermittent', 17);
  await browser.close();
}
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
