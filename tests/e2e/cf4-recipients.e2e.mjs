// CF4-ui: favourite recipients in the UI. Star a person in Transfers (keyboard), see the star and
// the first position persist after a reload (Transfers chips and the Overview card), picking a chip
// only fills the form, a failed toggle reverts with the error alert, unstar restores the order after a reload, a double click stars one person with one request,
// a second click during a slow save wins (CF6), no horizontal scroll at 390, clean console. No model calls.
// CF8: after a 1.10 € transfer to Hugo (scenario "normal", restored to "intermittent 17"), his chip
// reads "Paid <today>"; a person never paid has no Paid line; no horizontal scroll at 390.
//
// Run (app and bank already running):
//   APP_URL=http://127.0.0.1:3910 BANK_URL=http://127.0.0.1:4910 node tests/e2e/cf4-recipients.e2e.mjs
// PLAYWRIGHT_MODULE, PLAYWRIGHT_CHANNEL, SHOTS and LABEL as in the other e2e suites.
import { APP_URL as URL, launch, SHOTS, requireBankUrl } from './env.mjs';
const BANK = requireBankUrl();
const ADMIN = process.env.BANK_ADMIN_SECRET || 'banana-local-admin';
const LABEL = process.env.LABEL || 'run';
const browser = await launch();
const PERSONA = 'elena';
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
async function open(viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.request.post(`${URL}/api/session`, { data: { userId: PERSONA } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((p) => localStorage.setItem('banana_person', p), PERSONA);
  await page.goto(URL);
  await page.waitForSelector('.page-heading');
  return { ctx, page, errors };
}
const nav = (page, label) => page.locator('nav button', { hasText: label }).click();
const chips = (page) => page.locator('.recipient-chips .recipient-chip');
// A chip's text is the avatar initials, then the first name (then ", favourite" for screen readers,
// then CF8's "Paid {date}" line). The name is the last line that is not the Paid line.
const firstName = (t) =>
  t
    .split('\n')
    .map((l) => l.replace(/\s*, favourite\s*$/, '').trim())
    .filter((l) => l && !/^Paid /.test(l))
    .at(-1);
const chipNames = async (page) => {
  await chips(page).first().waitFor();
  return (await chips(page).allInnerTexts()).map(firstName);
};
const cardNames = async (page) => {
  const buttons = page.locator('.recipients .recipient:not(.new)');
  await buttons.first().waitFor();
  return (await buttons.allInnerTexts()).map(firstName);
};
// Never left unhandled when the request does not happen (the "before" run).
const response = (page) =>
  page
    .waitForResponse((r) => r.url().includes('/api/recipients/favourites'), { timeout: 5000 })
    .catch(() => null);
const toggleFor = (page, first) =>
  page
    .locator('.chip-slot', { has: page.locator('.recipient-chip', { hasText: first }) })
    .locator('.favourite-toggle');
const pinnedIds = async (ctx) =>
  (await (await ctx.request.get(`${URL}/api/dashboard`)).json()).recipients?.favourites ?? [];
const noScrollX = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

// Start clean: unpin whatever a previous run left.
{
  const ctx = await browser.newContext();
  await ctx.request.post(`${URL}/api/session`, { data: { userId: PERSONA } });
  for (const accountId of await pinnedIds(ctx))
    await ctx.request.post(`${URL}/api/recipients/favourites`, {
      data: { accountId, favourite: false },
    });
  await ctx.close();
}

let target = '',
  before = [];
await run('CF4-ui star', async () => {
  const { ctx, page, errors } = await open();
  await nav(page, 'Transfers');
  before = await chipNames(page);
  target = before.at(-1);
  const toggle = toggleFor(page, target);
  check(
    'CF4-ui a favourite toggle per chip',
    (await page.locator('.favourite-toggle').count()) === before.length,
    `${before.length} chips`,
  );
  const label = await toggle.getAttribute('aria-label');
  check(
    'CF4-ui toggle labelled "Add … to favourites", not pressed',
    /^Add .+ to favourites$/.test(label ?? '') &&
      (await toggle.getAttribute('aria-pressed')) === 'false',
    label ?? 'no toggle',
  );
  // Keyboard: Tab from the chip reaches its toggle; Space presses it.
  await page.locator('.recipient-chip', { hasText: target }).focus();
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  check(
    'CF4-ui toggle follows its chip in tab order',
    focused === label,
    focused ?? 'nothing focused',
  );
  const saved = response(page);
  await page.keyboard.press('Space');
  check(
    'CF4-ui pressed at once (optimistic)',
    (await toggle.getAttribute('aria-pressed')) === 'true',
  );
  check('CF4-ui POST saved', !!(await saved)?.ok());
  check(
    'CF4-ui label becomes "Remove … from favourites"',
    /^Remove .+ from favourites$/.test((await toggle.getAttribute('aria-label')) ?? ''),
  );
  check('CF4-ui server stores one pinned account', (await pinnedIds(ctx)).length === 1);
  const still = await chipNames(page);
  check(
    'CF4-ui chip order stays put while the page is open',
    still.join() === before.join(),
    still.join(' | '),
  );
  check('CF4-ui clean console (star)', errors.length === 0, errors.join(' | '));
  await ctx.close();
});

await run('CF4-ui persist', async () => {
  const { ctx, page, errors } = await open();
  const card = await cardNames(page);
  check('CF4-ui Overview: favourite is the first recipient', card[0] === target, card.join(' | '));
  const first = page.locator('.recipients .recipient:not(.new)').first();
  check(
    'CF4-ui Overview: star badge and accessible name',
    (await first.locator('.fav').count()) === 1 &&
      /, favourite$/.test((await first.innerText()).replace(/\s+/g, ' ').trim()),
  );
  await page.screenshot({ path: `${SHOTS}/overview-1280-${LABEL}.png` });
  await nav(page, 'Transfers');
  await page.reload();
  await page.waitForSelector('.page-heading');
  const names = await chipNames(page);
  check(
    'CF4-ui Transfers: favourite is the first chip after a reload',
    names[0] === target,
    names.join(' | '),
  );
  check(
    'CF4-ui Transfers: toggle still pressed after a reload',
    (await toggleFor(page, target).getAttribute('aria-pressed')) === 'true',
  );
  // R1: picking a chip only fills the form.
  const actions = [];
  page.on('request', (r) => r.url().includes('/api/actions') && actions.push(r.url()));
  await chips(page).first().click();
  const picked = await page
    .getByLabel('Recipient', { exact: true })
    .locator('option:checked')
    .innerText();
  check(
    'CF4-ui chip fills Recipient and sends nothing',
    picked.startsWith(target) && actions.length === 0,
    `${picked}, ${actions.length} action calls`,
  );
  await page
    .locator('.transfer-details')
    .screenshot({ path: `${SHOTS}/transfers-1280-${LABEL}.png` });
  check('CF4-ui clean console (reload)', errors.length === 0, errors.join(' | '));
  await ctx.close();
});

await run('CF4-ui error reverts', async () => {
  const { ctx, page } = await open();
  await nav(page, 'Transfers');
  await chipNames(page);
  await page.route('**/api/recipients/favourites', (r) =>
    r.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'The bank is not responding. Try again.' }),
    }),
  );
  const toggle = toggleFor(page, target);
  await toggle.click();
  await page.locator('.alert.error').waitFor();
  check(
    'CF4-ui failed unstar reverts to pressed',
    (await toggle.getAttribute('aria-pressed')) === 'true',
  );
  check(
    'CF4-ui failed unstar shows the error alert',
    /bank is not responding/.test(await page.locator('.alert.error').innerText()),
  );
  check('CF4-ui nothing changed on the server', (await pinnedIds(ctx)).length === 1);
  await ctx.close();
});

await run('CF4-ui unstar', async () => {
  const { ctx, page, errors } = await open();
  await nav(page, 'Transfers');
  await chipNames(page);
  const toggle = toggleFor(page, target);
  const saved = response(page);
  await toggle.focus();
  await page.keyboard.press('Enter');
  await saved;
  check(
    'CF4-ui unstar: not pressed, "Add" label',
    (await toggle.getAttribute('aria-pressed')) === 'false' &&
      /^Add /.test((await toggle.getAttribute('aria-label')) ?? ''),
  );
  check('CF4-ui unstar leaves nothing pinned', (await pinnedIds(ctx)).length === 0);
  await page.reload();
  await page.waitForSelector('.page-heading');
  const names = await chipNames(page);
  check(
    'CF4-ui unstar restores the previous order after a reload',
    names.join() === before.join(),
    names.join(' | '),
  );
  check('CF4-ui clean console (unstar)', errors.length === 0, errors.join(' | '));
  await ctx.close();
});

// Review of #65: a double click must star one person with one request, never the neighbour that
// slides into place when the list re-ranks.
await run('CF4-ui double click', async () => {
  const { ctx, page, errors } = await open();
  await nav(page, 'Transfers');
  const names = await chipNames(page);
  const posts = [];
  page.on(
    'request',
    (r) => r.url().includes('/api/recipients/favourites') && posts.push(r.postData()),
  );
  await toggleFor(page, names[1]).dblclick();
  await page.waitForTimeout(1500);
  const pinned = await pinnedIds(ctx);
  check('CF4-ui double click sends exactly one request', posts.length === 1, posts.join(' | '));
  check(
    'CF4-ui double click pins exactly one person',
    pinned.length === 1 &&
      (await page.locator('.favourite-toggle[aria-pressed="true"]').count()) === 1,
    pinned.join(', '),
  );
  check(
    'CF4-ui double click pins the person clicked',
    (await toggleFor(page, names[1]).getAttribute('aria-pressed')) === 'true',
  );
  for (const accountId of pinned)
    await ctx.request.post(`${URL}/api/recipients/favourites`, {
      data: { accountId, favourite: false },
    });
  check('CF4-ui clean console (double click)', errors.length === 0, errors.join(' | '));
  await ctx.close();
});

// CF6: a second click while the first save is still in flight is not dropped. The save is held
// for 1.5 s; star, then (past the double-click window) unstar: the last click is what is saved.
await run('CF6 second click during save', async () => {
  const { ctx, page, errors } = await open();
  await nav(page, 'Transfers');
  const names = await chipNames(page);
  const posts = [];
  page.on(
    'request',
    (r) => r.url().includes('/api/recipients/favourites') && posts.push(r.postData()),
  );
  await page.route('**/api/recipients/favourites', async (r) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await r.continue();
  });
  const toggle = toggleFor(page, names[2]);
  await toggle.click();
  await page.waitForTimeout(700);
  await toggle.click();
  check(
    'CF6 second click shows "Add" at once',
    (await toggle.getAttribute('aria-pressed')) === 'false',
  );
  await page.waitForTimeout(4000);
  const pinned = await pinnedIds(ctx);
  check('CF6 the last click is what the server saved', pinned.length === 0, pinned.join(', '));
  check(
    'CF6 the star shows the saved state',
    (await toggle.getAttribute('aria-pressed')) === 'false',
  );
  check('CF6 at most 2 requests', posts.length >= 1 && posts.length <= 2, posts.join(' | '));
  for (const accountId of pinned)
    await ctx.request.post(`${URL}/api/recipients/favourites`, {
      data: { accountId, favourite: false },
    });
  check('CF6 clean console', errors.length === 0, errors.join(' | '));
  await ctx.close();
});

// CF6 review of #75: saves for two people overlap and settle out of order (Carla's reply held
// 2.5 s, Diego's 0.2 s). The late settle must not wipe Diego's star: screen and server agree.
await run('CF6 two people, out-of-order settles', async () => {
  const { ctx, page, errors } = await open();
  await nav(page, 'Transfers');
  await chipNames(page);
  await page.route('**/api/recipients/favourites', async (r) => {
    // The server saves at once; only the reply is held, so Carla's reply lists no Diego.
    const slow = JSON.parse(r.request().postData() ?? '{}').accountId === 'acc-carla';
    const reply = await r.fetch();
    await new Promise((resolve) => setTimeout(resolve, slow ? 2500 : 200));
    await r.fulfill({ response: reply });
  });
  await toggleFor(page, 'Carla').click();
  await toggleFor(page, 'Diego').click();
  await page.waitForTimeout(4000);
  const pinned = (await pinnedIds(ctx)).sort();
  const shown = [];
  for (const [name, id] of [
    ['Carla', 'acc-carla'],
    ['Diego', 'acc-diego'],
  ])
    if ((await toggleFor(page, name).getAttribute('aria-pressed')) === 'true') shown.push(id);
  check(
    'CF6 overlapping saves: the server has both',
    pinned.join() === 'acc-carla,acc-diego',
    pinned.join(', '),
  );
  check(
    'CF6 overlapping saves: the screen matches the server',
    shown.join() === pinned.join(),
    `screen ${shown.join(', ')} / server ${pinned.join(', ')}`,
  );
  for (const accountId of pinned)
    await ctx.request.post(`${URL}/api/recipients/favourites`, {
      data: { accountId, favourite: false },
    });
  check('CF6 clean console (two people)', errors.length === 0, errors.join(' | '));
  await ctx.close();
});

await run('CF4-ui 390', async () => {
  const { ctx, page, errors } = await open({ width: 390, height: 844 });
  await ctx.request.post(`${URL}/api/recipients/favourites`, {
    data: { accountId: 'acc-hugo', favourite: true },
  });
  await page.reload();
  await page.waitForSelector('.page-heading');
  await cardNames(page);
  check('CF4-ui no horizontal scroll at 390 (Overview)', await noScrollX(page));
  await page.screenshot({ path: `${SHOTS}/overview-390-${LABEL}.png`, fullPage: true });
  await page.goto(`${URL}/?tab=transfers`);
  await chipNames(page);
  check('CF4-ui no horizontal scroll at 390 (Transfers)', await noScrollX(page));
  await page
    .locator('.transfer-details')
    .screenshot({ path: `${SHOTS}/transfers-390-${LABEL}.png` });
  check('CF4-ui clean console (390)', errors.length === 0, errors.join(' | '));
  await ctx.request.post(`${URL}/api/recipients/favourites`, {
    data: { accountId: 'acc-hugo', favourite: false },
  });
  await ctx.close();
});

await run('CF8 Paid line', async () => {
  const scenario = (profile, seed = 17) =>
    fetch(`${BANK}/admin/scenario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify({ profile, seed }),
    });
  await scenario('normal');
  try {
    const { ctx, page, errors } = await open();
    const proposal = await (
      await ctx.request.post(`${URL}/api/actions`, {
        data: {
          name: 'transfer_money',
          arguments: {
            fromAccountId: 'acc-elena',
            toAccountId: 'acc-hugo',
            amountCents: 110,
            concept: 'CF8 paid line',
          },
          intentId: `cf8-${Date.now().toString(36)}`,
        },
      })
    ).json();
    const done = await (
      await ctx.request.post(`${URL}/api/approvals/${proposal.approval?.id}/confirm`, { data: {} })
    ).json();
    check('CF8 transfer to Hugo completed', done.status === 'completed', done.status);
    const dash = await (await ctx.request.get(`${URL}/api/dashboard`)).json();
    const paidIds = (dash.recipients?.recent ?? []).map((r) => r.accountId);
    const hugo = dash.contacts.find((c) => c.id === 'acc-hugo');
    const unpaid = dash.contacts.find(
      (c) =>
        c.userId !== hugo.userId &&
        !dash.contacts.some((o) => o.userId === c.userId && paidIds.includes(o.id)),
    );
    const today = new Intl.DateTimeFormat('en-IE', { day: 'numeric', month: 'short' }).format(
      new Date(),
    );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${URL}/?tab=transfers`);
      await chipNames(page);
      const chip = (name) => page.locator('.recipient-chip', { hasText: name.split(' ')[0] });
      const paid = chip(hugo.name).locator('.chip-paid');
      check(
        `CF8 Hugo's chip reads "Paid ${today}" (${width})`,
        (await paid.count()) === 1 && (await paid.innerText()).trim() === `Paid ${today}`,
        (await paid.count()) ? await paid.innerText() : 'no Paid line',
      );
      check(
        `CF8 a person never paid has no Paid line (${width})`,
        !!unpaid && (await chip(unpaid.name).locator('.chip-paid').count()) === 0,
        unpaid?.name ?? 'every person was paid',
      );
      check(`CF8 no horizontal scroll (${width})`, await noScrollX(page));
      await page
        .locator('.recipient-chips')
        .screenshot({ path: `${SHOTS}/cf8-chips-${width}-${LABEL}.png` });
    }
    check('CF8 clean console', errors.length === 0, errors.join(' | '));
    await ctx.close();
  } finally {
    await scenario('intermittent');
  }
});

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
