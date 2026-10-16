// SI7a: spend insights on Overview (card, chips, "why", select, offer, learning notice, rules,
// pending refresh) against a running app. No model calls (run the app with DECIDER=none).
//
// It works on any bank. On the simulator it changes one movement's category (a different one on
// each run) and stubs the states that bank cannot produce (candidates, pending, a refusal). The
// last block needs the demo bank (`npm run demo`, movement ids `demo-…`) and prints SKIP lines
// elsewhere: it creates and removes Bruno's rule for ESPAI NOU and confirms other movements of
// his by hand (IT6: a review group that offers the rule, "Confirm"), so it needs a fresh DEMO_DATA_DIR to
// pass again.
//
// Run (app and bank already running):
//   APP_URL=http://127.0.0.1:3000 node tests/e2e/insights-overview.e2e.mjs
// PLAYWRIGHT_MODULE / PLAYWRIGHT_CHANNEL / SHOTS as in the other e2e scripts.
import { APP_URL as URL, launch, SHOTS } from './env.mjs';
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
const money = (cents) =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const HYDRATION = /hydrat|did not match|server rendered HTML|error #(418|423|425)/i;
const STATES = ['estimated', 'confirmed', 'needs_review', 'pending'];
const LABELS = {
  groceries: 'Groceries',
  eating_out_leisure: 'Eating out & leisure',
  transport: 'Transport',
  home_utilities: 'Home & utilities',
  health: 'Health',
  shopping: 'Shopping',
  work: 'Work & projects', // CAT1
  transfer_person: 'Transfers to people',
  savings_internal: 'Savings / own transfer',
  income: 'Income',
  other: 'Other',
};
const ALL = Object.keys(LABELS);

// `stub(dashboard)` edits the real dashboard answer before the page gets it.
async function open(persona, { viewport = { width: 1440, height: 900 }, stub, delay = 0 } = {}) {
  const ctx = await browser.newContext({ viewport });
  await ctx.request.post(`${URL}/api/session`, { data: { userId: persona } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  let reads = 0;
  let open = 0;
  let most = 0;
  if (stub)
    await page.route('**/api/dashboard', async (route) => {
      most = Math.max(most, ++open);
      try {
        const real = await (await route.fetch()).json();
        if (delay) await new Promise((r) => setTimeout(r, delay));
        reads++;
        open--;
        await route.fulfill({ json: stub(real) ?? real });
      } catch {
        // The context was closed while this read was on its way.
      }
    });
  await page.addInitScript((p) => localStorage.setItem('banana_person', p), persona);
  await page.goto(`${URL}/?tab=overview`);
  await page.waitForSelector(persona === 'marta' ? 'main' : '.account-card');
  await page.waitForLoadState('networkidle');
  const dashboard = async () => (await ctx.request.get(`${URL}/api/dashboard`)).json();
  return {
    ctx,
    page,
    errors,
    dashboard,
    reads: () => reads,
    mostAtOnce: (reset) => (reset ? (most = open) : most),
  };
}
const json = (route, body, status = 200) => route.fulfill({ status, json: body });
// A row by its exact title (every row's select holds every category label, so `hasText` on the
// row would match them all).
const rowOf = (page, title) =>
  page.locator('.movements .movement').filter({
    has: page.locator('strong', {
      hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    }),
  });
// The first bank movement matching `pred` that is exactly one row of the table.
async function movementRow(page, movements, pred) {
  for (const m of movements.filter((x) => x.category?.movementIds.length === 1 && pred(x)))
    if ((await rowOf(page, m.description).count()) === 1)
      return { m, row: rowOf(page, m.description) };
  throw new Error('no movement row matches');
}
const viewAll = async (page) => {
  const all = page.getByRole('button', { name: 'View all' });
  if (await all.count()) await all.click();
};
const focusOn = (page, cls) =>
  page.waitForFunction((c) => document.activeElement?.classList.contains(c), cls);
const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

const first = await open('lucia');
const dash = await first.dashboard();
const demo = dash.movements.some((m) => m.id.startsWith('demo-'));
console.log(`Bank: ${demo ? 'demo bank' : 'not the demo bank (demo checks are skipped)'}`);

await run('Card and chips', async () => {
  const { page } = first;
  const card = page.getByTestId('spending-card');
  await card.waitFor();
  // IT8 (contracts.md 2.17 and 2.19; added by the reviewer of #127, a third party): a month chosen
  // in the card shows that month's figures. The oldest month with movements, else the current one.
  // Reconciled to the period dropdown (contracts.md 2.22, §8) by the reviewer of #136, a third
  // party: the options are in a menu opened with `spending-period`, which closes after a choice,
  // so the wait is on the button's `data-period` (the value sent), no longer on the pressed
  // option. A month is clicked in the month grid, by its name ("Sep 2026"): the quick choice
  // "Last month" carries the same `data-period`. No assertion changed.
  const MONTHS = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const pick = async (id) => {
    const menu = card.getByTestId('spending-period-menu');
    if (!(await menu.count())) await card.getByTestId('spending-period').click();
    let option = menu.locator(`[data-testid="spending-period-option"][data-period="${id}"]`);
    if (/^\d{4}-\d{2}$/.test(id)) {
      const year = menu.locator('[aria-live]');
      for (let i = 0; i < 20 && (await year.innerText()).trim() !== id.slice(0, 4); i++)
        await menu
          .getByRole('button', {
            name: (await year.innerText()).trim() > id.slice(0, 4) ? 'Previous year' : 'Next year',
          })
          .click();
      option = option.and(
        menu.getByRole('button', {
          name: `${MONTHS[Number(id.slice(5)) - 1]} ${id.slice(0, 4)}`,
          exact: true,
        }),
      );
    }
    await option.click();
    await card.locator(`[data-testid="spending-period"][data-period="${id}"]`).waitFor();
    await page.locator('[data-testid="spending-card"][aria-busy="false"]').waitFor();
  };
  const months = dash.insights.periods.filter((p) => p.id !== 'all');
  const month = months.findLast((p) => p.count > 0) ?? months[0];
  await pick(month.id);
  const ofMonth = (
    await (
      await first.ctx.request.get(`${URL}/api/dashboard`, {
        headers: { 'x-insights-period': month.id },
      })
    ).json()
  ).insights;
  const monthRows = await card
    .getByTestId('spending-category')
    .evaluateAll((els) => els.map((e) => [e.dataset.category, e.innerText.replace(/\s+/g, ' ')]));
  check(
    'IT8 choosing a month makes the card total and rows equal dashboard.insights of that month',
    ofMonth.period === month.id &&
      (await card.innerText()).includes(money(ofMonth.spentCents)) &&
      (ofMonth.spentCents > 0
        ? monthRows.length === ofMonth.categories.length &&
          ofMonth.categories.every(
            (c, i) => monthRows[i][0] === c.id && monthRows[i][1].includes(money(c.spentCents)),
          )
        : monthRows.length === 0),
    `${month.id}: ${money(ofMonth.spentCents)} in ${monthRows.length} rows (whole window ${money(dash.insights.spentCents)})`,
  );
  // Reconciled to the period rule (contracts.md 2.19: the card shows the selected period, the
  // current month by default; the Transactions table is the whole window) by the reviewer of
  // #127: the checks of this page compare the card with the parameterless dashboard (the whole
  // window), up to the reload in "Change a category", so "All" is selected first. No assertion
  // changed.
  await pick('all');
  check(
    'the card sits in the designer slot',
    (await page
      .locator('[data-testid="overview-insights"] [data-testid="spending-card"]')
      .count()) === 1,
  );
  const ins = dash.insights;
  const shown = await card
    .getByTestId('spending-category')
    .evaluateAll((els) => els.map((e) => [e.dataset.category, e.innerText.replace(/\s+/g, ' ')]));
  check(
    'REQ-SI7-3 one row per category with spend; amounts equal dashboard.insights',
    shown.length === ins.categories.length &&
      ins.categories.every(
        (c, i) => shown[i][0] === c.id && shown[i][1].includes(money(c.spentCents)),
      ) &&
      (await card.innerText()).includes(money(ins.spentCents)),
    shown.map((s) => s[1]).join(' | '),
  );
  const note = await page.getByTestId('spending-window-note').innerText();
  check(
    'REQ-SI7-3 the window note names the count and the oldest date',
    new RegExp(
      `^Covers the ${ins.window.returned} most recent movements? the bank returned, since \\d+ \\w+ \\d{4}\\.`,
    ).test(note),
    note,
  );
  await viewAll(page);
  const rows = await page.locator('.movements .movement').evaluateAll((els) =>
    els.map((e) => ({
      proposal: /\b(pending|verifying)\b/.test(e.className),
      chips: [...e.querySelectorAll('[data-testid="category-chip"]')].map((c) => c.dataset.state),
      selects: e.querySelectorAll('[data-testid="category-select"]').length,
      asks: [...e.querySelectorAll('[data-testid="category-ask"]')].map((b) => b.innerText),
      smalls: e.querySelectorAll('small').length,
      extra: e.querySelectorAll('.movement-extra').length,
    })),
  );
  const bank = rows.filter((r) => !r.proposal);
  check(
    'REQ-SI7-2 every bank movement row has one chip with a known state and one select',
    bank.length > 0 &&
      bank.every((r) => r.chips.length === 1 && STATES.includes(r.chips[0]) && r.selects === 1),
    `${bank.length} rows`,
  );
  check(
    'proposal rows have no chip and no empty wrapper; every row keeps one <small>',
    rows.filter((r) => r.proposal).every((r) => r.chips.length === 0 && r.extra === 0) &&
      rows.every((r) => r.smalls === 1),
  );
  // SI7b: the button is wired (its flow is in insights-assistant.e2e.mjs).
  check(
    'REQ-SI7-2 every bank movement row has one "Ask the assistant" button; proposal rows none',
    bank.every((r) => r.asks.length === 1 && r.asks[0] === 'Ask the assistant') &&
      rows.filter((r) => r.proposal).every((r) => r.asks.length === 0),
  );
  if (demo) console.log('SKIP simulator chip texts — demo bank');
  else {
    const text = await rowOf(page, 'Groceries').first().getByTestId('category-chip').innerText();
    check(
      'simulator: the "Groceries" row is Groceries · estimated',
      text === 'Groceries · estimated',
      text,
    );
  }
  await page.screenshot({ path: `${SHOTS}/si7a-overview-1440.png`, fullPage: true });
});

await run('Why and select', async () => {
  const { page } = first;
  const row = page.locator('.movements .movement:has([data-testid="category-chip"])').first();
  const chip = row.getByTestId('category-chip');
  const why = row.getByTestId('category-why');
  check('the "why" is closed at first', !(await why.isVisible()));
  await chip.click();
  const text = await why.innerText();
  check(
    'REQ-SI7-10 a click on the chip shows the "why", also the chip\'s title',
    (await why.isVisible()) && text.length > 3 && (await chip.getAttribute('title')) === text,
    text,
  );
  await chip.click();
  check('a second click closes it', !(await why.isVisible()));
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const onFocus = await why.isVisible();
  await page.keyboard.press('Enter');
  check(
    'keyboard: focus on the chip shows the "why"; Enter keeps it open (aria-expanded)',
    onFocus && (await chip.getAttribute('aria-expanded')) === 'true',
  );
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.dataset.testid);
  check('keyboard: Tab goes from the chip to its select', focused === 'category-select', focused);

  const optionsOf = async (sign) => {
    const { row } = await movementRow(
      page,
      dash.movements,
      (x) => Math.sign(x.amountCents) === sign,
    );
    const values = await row
      .getByTestId('category-select')
      .locator('option')
      .evaluateAll((os) => os.map((o) => o.value));
    return values.join();
  };
  check(
    'REQ-SI7-5 a debit offers every category but income; a credit every one but transfers to people',
    (await optionsOf(-1)) === ALL.filter((c) => c !== 'income').join() &&
      (await optionsOf(1)) === ALL.filter((c) => c !== 'transfer_person').join(),
  );
  // Review of #101: the names are attributes, so the accessibility tree must still have them.
  const cdp = await page.context().newCDPSession(page);
  const names = (await cdp.send('Accessibility.getFullAXTree')).nodes
    .filter((n) => /option/i.test(n.role?.value ?? ''))
    .map((n) => n.name?.value ?? '');
  check(
    'every option has an accessible name; the category names are among them',
    names.every(Boolean) && Object.values(LABELS).every((l) => names.includes(l)),
    `${names.filter((n) => !n).length} of ${names.length} unnamed`,
  );
});

await run('Change a category', async () => {
  const { page, dashboard } = first;
  // A card debit the rules decided (the simulator's "Coffee shop"); a different target each run.
  const { m, row } = await movementRow(
    page,
    (await dashboard()).movements,
    (x) =>
      x.amountCents < 0 && (demo ? x.category.source === 'rule' : x.description === 'Coffee shop'),
  );
  const target = m.category.id === 'health' ? 'shopping' : 'health';
  const chip = row.getByTestId('category-chip');
  const [request] = await Promise.all([
    page.waitForRequest((r) => r.url().endsWith('/api/insights/categories')),
    row.getByTestId('category-select').selectOption(target),
  ]);
  const body = request.postDataJSON();
  check(
    "REQ-SI7-5 the select posts the row's movementIds and the category",
    JSON.stringify(body) ===
      JSON.stringify({ movementIds: m.category.movementIds, category: target }),
    JSON.stringify(body),
  );
  await row.locator(`[data-testid="category-chip"][data-state="confirmed"]`).waitFor();
  check(
    'REQ-SI7-5 the chip is the bare label, confirmed, with a mark',
    (await chip.innerText()) === LABELS[target] &&
      (await chip.getAttribute('data-category')) === target &&
      (await chip.locator('svg').count()) === 1,
    await chip.innerText(),
  );
  const after = (await dashboard()).insights.categories.find((c) => c.id === target);
  await page
    .locator(`[data-testid="spending-category"][data-category="${target}"]`, {
      hasText: money(after.spentCents),
    })
    .waitFor({ timeout: 5000 });
  check(
    'the card moved the amount',
    after.confirmedCents >= -m.amountCents,
    money(after.spentCents),
  );
  await page.reload();
  await page.getByTestId('spending-card').waitFor();
  await viewAll(page);
  const again = rowOf(page, m.description).getByTestId('category-chip');
  check(
    'REQ-SI7-5 it survives a reload',
    (await again.getAttribute('data-state')) === 'confirmed' &&
      (await again.innerText()) === LABELS[target],
  );
  check(
    'the "why" of a hand-set category',
    (await again.getAttribute('title')) === 'Set by you',
    await again.getAttribute('title'),
  );
});

await run('Refused change', async () => {
  const { page } = first;
  const row = page
    .locator('.movements .movement:has([data-testid="category-chip"][data-state="estimated"])')
    .first();
  const select = row.getByTestId('category-select');
  const before = await select.inputValue();
  await page.route('**/api/insights/categories', (route) =>
    json(route, { error: 'This category does not fit this movement.' }, 400),
  );
  await select.selectOption(before === 'other' ? 'shopping' : 'other');
  const alert = row.getByRole('alert');
  await alert.waitFor();
  // The chosen value shows until the request and the dashboard read after it have ended (SI7b:
  // this read lost the race on a busy machine).
  await select.and(page.locator('[aria-busy="false"]')).waitFor();
  check(
    'a refused change is reported in the row and rolled back, never shown as confirmed',
    (await alert.innerText()) === 'This category does not fit this movement.' &&
      (await select.inputValue()) === before &&
      (await row.getByTestId('category-chip').getAttribute('data-state')) === 'estimated',
    await alert.innerText(),
  );
  await row.getByRole('button', { name: 'Dismiss' }).click();
  check('the error can be dismissed', (await row.getByRole('alert').count()) === 0);
  await page.unroute('**/api/insights/categories');
  await first.ctx.close();
});

// A review group with candidates and probabilities needs a model: stubbed (contracts.md §7).
await run('Review list, offer, notice, Undo (stubbed)', async () => {
  const ids = dash.movements
    .filter((m) => m.amountCents < 0)
    .slice(0, 3)
    .map((m) => m.id);
  const group = {
    merchantKey: 'ZZQXV ALPHA',
    title: 'ZZQXV ALPHA 0412',
    count: 3,
    totalCents: 4500,
    movementIds: ids,
    candidates: [
      { category: 'shopping', p: 0.48 },
      { category: 'eating_out_leisure', p: 0.31 },
    ],
    reason: 'below_threshold',
  };
  let resolved = false;
  const { ctx, page } = await open('lucia', {
    stub: (d) => {
      d.insights.unresolved = resolved
        ? { count: 0, totalCents: 0, groups: [] }
        : { count: 3, totalCents: 4500, groups: [group] };
    },
  });
  const posts = [];
  const deletes = [];
  let rules = [];
  await page.route('**/api/insights/categories', (route) => {
    const body = route.request().postDataJSON();
    posts.push(body);
    resolved = true;
    if (body.applyToSimilar)
      rules = [
        { merchantKey: 'ZZQXV ALPHA', category: 'shopping', createdAt: '2026-10-04T10:00:00Z' },
      ];
    return json(route, {
      updated: body.applyToSimilar ? 2 : 3,
      similar: [{ merchantKey: 'ZZQXV ALPHA', count: 2, movementIds: ['x', 'y'] }],
      rules: rules.map((r) => r.merchantKey),
    });
  });
  await page.route('**/api/insights/rules', (route) => json(route, { rules }));
  await page.route('**/api/insights/rules/*', (route) => {
    deletes.push(
      `${route.request().method()} ${new globalThis.URL(route.request().url()).pathname}`,
    );
    rules = [];
    return json(route, { removed: true, reclassified: 2 });
  });
  await page.reload();
  const groups = page.getByTestId('unresolved-group');
  await groups.first().waitFor();
  const buttons = await groups.getByTestId('unresolved-candidate').allInnerTexts();
  check(
    'REQ-SI7-4 one group per merchant with its candidates and probabilities',
    (await groups.count()) === 1 &&
      (await groups.getAttribute('data-merchant')) === 'ZZQXV ALPHA' &&
      buttons.join() === 'Shopping 48%,Eating out & leisure 31%' &&
      /3 movements · €45\.00/.test(await groups.innerText()),
    buttons.join(' | '),
  );
  await page.screenshot({ path: `${SHOTS}/si7a-review-1440.png` });
  await page.locator('[data-testid="unresolved-candidate"][data-category="shopping"]').focus();
  await page.keyboard.press('Enter');
  const yes = page.getByTestId('similar-offer-yes');
  await yes.waitFor();
  check(
    "a candidate posts the group's ids and the category",
    JSON.stringify(posts) === JSON.stringify([{ movementIds: ids, category: 'shopping' }]),
    JSON.stringify(posts),
  );
  const offer = await page.locator('.spend-insights .si-feedback [role="status"]').innerText();
  check(
    'REQ-SI7-6 the offer appears once, in words',
    (await yes.count()) === 1 &&
      offer === 'Apply Shopping to the 2 other ZZQXV ALPHA movements and to future ones?',
    offer,
  );
  await page.getByTestId('unresolved-group').waitFor({ state: 'detached' });
  check('REQ-SI7-4 with nothing left to review, no group is shown', true);
  // Keyboard: the group is gone, so focus continues from the offer; Tab reaches "Yes".
  await focusOn(page, 'si-feedback');
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.dataset.testid);
  check('keyboard: Tab goes on to "Yes, apply to all"', focused === 'similar-offer-yes', focused);
  await page.keyboard.press('Enter');
  const notice = page.getByTestId('insights-notice');
  await notice.waitFor();
  check(
    'REQ-SI7-6 "Yes" posts applyToSimilar: true; the notice names the merchant and the category',
    posts.length === 2 &&
      posts[1].applyToSimilar === true &&
      (await notice.getAttribute('role')) === 'status' &&
      (await notice.innerText()).startsWith(
        'Learned: ZZQXV ALPHA is Shopping. 2 movements updated.',
      ) &&
      (await yes.count()) === 0,
    await notice.innerText(),
  );
  const rule = page.getByTestId('rule-item');
  await rule.waitFor();
  check(
    'REQ-SI7-7 the rule is listed',
    (await rule.getAttribute('data-merchant')) === 'ZZQXV ALPHA' &&
      /ZZQXV ALPHA.*Shopping/s.test(await rule.innerText()),
  );
  await page.screenshot({ path: `${SHOTS}/si7a-notice-1440.png` });
  await focusOn(page, 'si-feedback');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter'); // Undo, by keyboard
  await rule.waitFor({ state: 'detached' });
  check(
    'REQ-SI7-7 Undo calls the DELETE route of the rule (key URL-encoded); the rule is gone',
    deletes.join() === 'DELETE /api/insights/rules/ZZQXV%20ALPHA' && (await notice.count()) === 0,
    deletes.join(),
  );
  await ctx.close();
});

// IT6 (A8): a whole group usually leaves no similar movement. It then offers the rule for the
// future only; the rule is made on "Yes", never before. What is possible comes from the answer.
await run('Review group, future-only offer (stubbed)', async () => {
  const ids = dash.movements
    .filter((m) => m.amountCents < 0)
    .slice(0, 2)
    .map((m) => m.id);
  const group = (merchantKey) => ({
    merchantKey,
    title: merchantKey || 'ZZQXV NO KEY 77',
    count: 2,
    totalCents: 3000,
    movementIds: ids,
    candidates: [],
    reason: 'no_decider',
  });
  // What the bank answer says of the group: 'ruled' (a rule is possible and is made on yes),
  // 'refused' (possible by `similar`, but the yes answer has no rule), 'none' (no rule possible).
  let kind = 'ruled';
  const { ctx, page } = await open('lucia', {
    stub: (d) => {
      d.insights.unresolved = {
        count: 2,
        totalCents: 3000,
        groups: [group(kind === 'none' ? '' : 'ZZQXV DELTA')],
      };
    },
  });
  const posts = [];
  await page.route('**/api/insights/categories', (route) => {
    const body = route.request().postDataJSON();
    posts.push(body);
    return json(route, {
      updated: body.applyToSimilar ? 0 : 2,
      similar: kind === 'none' ? [] : [{ merchantKey: 'ZZQXV DELTA', count: 0, movementIds: [] }],
      rules: body.applyToSimilar && kind === 'ruled' ? ['ZZQXV DELTA'] : [],
    });
  });
  await page.reload();
  const select = page.getByTestId('unresolved-group').locator('select');
  const line = page.locator('.spend-insights > .si-feedback');
  const yes = line.getByTestId('similar-offer-yes');
  const idle = () => page.locator('[data-testid="spending-card"][aria-busy="false"]').waitFor();
  await select.selectOption('shopping');
  await yes.waitFor();
  const offer = await line.locator('[role="status"]').innerText();
  check(
    "IT6 A8 a group change posts the group's ids, makes no rule and offers it for the future, once",
    JSON.stringify(posts) === JSON.stringify([{ movementIds: ids, category: 'shopping' }]) &&
      offer === 'Remember this for future ZZQXV DELTA movements?' &&
      (await yes.innerText()) === 'Yes, remember it' &&
      (await line.getByTestId('similar-offer-no').innerText()) === 'No, only these' &&
      (await page.getByTestId('similar-offer-yes').count()) === 1 &&
      (await page.getByTestId('insights-notice').count()) === 0,
    `${JSON.stringify(posts)} · ${offer}`,
  );
  await page.screenshot({ path: `${SHOTS}/it6-future-offer-1440.png` });
  await idle();
  await yes.click();
  const notice = page.getByTestId('insights-notice');
  await notice.waitFor();
  check(
    'IT6 A8 "Yes" posts the same ids with applyToSimilar: true; the notice with Undo follows',
    posts.length === 2 &&
      JSON.stringify(posts[1]) ===
        JSON.stringify({ movementIds: ids, category: 'shopping', applyToSimilar: true }) &&
      (await notice.innerText()).startsWith('Learned: ZZQXV DELTA is Shopping.') &&
      (await line.getByTestId('insights-undo').count()) === 1,
    await notice.innerText(),
  );
  // "No": nothing more is posted or said.
  posts.length = 0;
  await idle();
  await select.selectOption('shopping');
  await yes.waitFor();
  await idle();
  await line.getByTestId('similar-offer-no').click();
  check(
    'IT6 A8 "No" posts nothing more: no rule, no notice, the line is gone',
    posts.length === 1 && (await line.count()) === 0,
    JSON.stringify(posts),
  );
  // The yes answer has no rule (a kind of movement no rule can decide): said, not shown as learned.
  kind = 'refused';
  await select.selectOption('shopping');
  await yes.waitFor();
  await idle();
  await yes.click();
  const said = line.locator('[role="status"]', { hasText: 'Only these' });
  await said.waitFor();
  check(
    'IT6 A8 a yes that made no rule (`rules: []`) is said honestly, never as "Learned"',
    (await said.innerText()) === 'Only these: no rule can be made for this kind of movement.' &&
      (await notice.count()) === 0,
    await said.innerText(),
  );
  // No rule possible (`similar: []`: no merchant key, a transfer): no offer at all.
  kind = 'none';
  posts.length = 0;
  await page.reload();
  await select.selectOption('shopping');
  await said.waitFor();
  check(
    'IT6 A8 no rule possible (`similar: []`): no offer; the card says only these were set',
    posts.length === 1 &&
      (await said.innerText()) ===
        '2 movements set to Shopping. Only these: no rule was made for future ones.' &&
      (await page.getByTestId('similar-offer-yes').count()) === 0,
    await said.innerText(),
  );
  await ctx.close();
});

await run('Merged internal row (stubbed)', async () => {
  const { ctx, page } = await open('lucia');
  const internal = (
    await (await ctx.request.get(`${URL}/api/movements?direction=internal`)).json()
  ).rows.find((r) => r.category?.movementIds.length === 2);
  if (!internal) {
    console.log('SKIP merged internal row — this customer has no move between own accounts');
    return ctx.close();
  }
  const posts = [];
  await page.route('**/api/insights/categories', (route) => {
    posts.push(route.request().postDataJSON());
    return json(route, { updated: 2, similar: [], rules: [] });
  });
  await viewAll(page);
  const row = rowOf(page, 'Between your accounts').first();
  const values = await row
    .getByTestId('category-select')
    .locator('option')
    .evaluateAll((os) => os.map((o) => o.value));
  await row.getByTestId('category-select').selectOption('other');
  await page.waitForResponse((r) => r.url().endsWith('/api/insights/categories'));
  check(
    'REQ-SI7-5 a "Between your accounts" row posts both legs; no income or transfer to people',
    posts.length === 1 &&
      JSON.stringify(posts[0].movementIds) === JSON.stringify(internal.category.movementIds) &&
      posts[0].movementIds.length === 2 &&
      !values.includes('income') &&
      !values.includes('transfer_person'),
    JSON.stringify(posts),
  );
  await ctx.close();
});

await run('"No, only this one" (stubbed)', async () => {
  const { ctx, page } = await open('lucia');
  const posts = [];
  await page.route('**/api/insights/categories', (route) => {
    posts.push(route.request().postDataJSON());
    return json(route, {
      updated: 1,
      similar: [{ merchantKey: 'ZZQXV BETA', count: 4, movementIds: ['a', 'b', 'c', 'd'] }],
      rules: [],
    });
  });
  const row = page.locator('.movements .movement:has([data-testid="category-chip"])').first();
  const select = row.getByTestId('category-select');
  await select.selectOption((await select.inputValue()) === 'other' ? 'shopping' : 'other');
  // From a row, the offer is in that row, right after the select.
  const no = row.getByTestId('similar-offer-no');
  await no.waitFor();
  await page.screenshot({ path: `${SHOTS}/si7a-offer-row-1440.png` });
  await no.click();
  check(
    'REQ-SI7-6 "No" posts nothing more and closes the offer; no notice',
    posts.length === 1 &&
      (await page.getByTestId('similar-offer-yes').count()) === 0 &&
      (await page.getByTestId('insights-notice').count()) === 0,
    JSON.stringify(posts),
  );
  await ctx.close();
});

await run('Pending (stubbed)', async () => {
  const stamps = [];
  const { ctx, page, reads } = await open('lucia', {
    stub: (d) => {
      stamps.push(Date.now());
      d.insights.pending = 2;
      for (const m of d.movements)
        if (m.category)
          Object.assign(m.category, {
            id: 'other',
            state: 'pending',
            source: 'none',
            reason: 'pending',
          });
    },
  });
  const status = page.locator('.spend-insights [role="status"]', { hasText: 'Classifying' });
  await status.waitFor();
  const chip = page.locator('[data-testid="category-chip"][data-state="pending"]').first();
  check(
    'pending: the card says how many, the chip says "Classifying…"',
    (await status.innerText()) === 'Classifying 2 movements…' &&
      (await chip.innerText()) === 'Classifying…',
  );
  const at = reads();
  await page.waitForResponse((r) => r.url().endsWith('/api/dashboard'), { timeout: 5000 });
  await page.waitForTimeout(200);
  check(
    'REQ-SI7-11 while classifying the dashboard is read again within 5 s',
    reads() > at && stamps.at(-1) - stamps.at(-2) < 5000,
    `${stamps.at(-1) - stamps.at(-2)} ms after the previous read`,
  );
  await page.screenshot({ path: `${SHOTS}/si7a-pending-1440.png` });
  // IT6 (A14): a decider that hangs settles its row at about 32 s. Ten reads ended at 30 s (the
  // next read was the page's own, at 40 s); twelve end at 36 s.
  await page.waitForTimeout(Math.max(0, stamps[0] + 37500 - Date.now()));
  const late = stamps.map((t) => t - stamps[0]).filter((ms) => ms > 31500 && ms < 37500);
  check(
    'IT6 A14 while classifying, the 3 s reads go on after 30 s (12 of them)',
    late.length >= 1,
    `reads at ${late.map((ms) => `${(ms / 1000).toFixed(1)} s`).join(', ') || 'none'} (31.5–37.5 s)`,
  );
  await ctx.close();
});

// Review of #101: the fast reads never queue up behind a slow bank.
await run('Pending on a slow bank (stubbed)', async () => {
  const { ctx, page, reads, mostAtOnce } = await open('lucia', {
    delay: 4000,
    stub: (d) => {
      d.insights.pending = 2;
    },
  });
  await page.locator('.spend-insights [role="status"]', { hasText: 'Classifying' }).waitFor();
  // From here on (the page's first reads are its own): the fast reads of the next 11 s.
  mostAtOnce(true);
  const first = reads();
  await page.waitForTimeout(11000);
  check(
    'pending: one dashboard read at a time when a read takes longer than 3 s',
    mostAtOnce() === 1 && reads() - first >= 1,
    `${mostAtOnce()} at once, ${reads() - first} fast reads`,
  );
  await ctx.close();
});

// Review of #101: a movement in review holds `other` already, so its select cannot confirm it.
await run('Keep as Other (stubbed)', async () => {
  const target = dash.movements.find(
    (m) =>
      m.category?.movementIds.length === 1 &&
      m.amountCents < 0 &&
      // FX1: a transfer the app knows it sent is titled by its counterparty, not this text.
      !m.toAccountId &&
      dash.movements.filter((x) => x.description === m.description).length === 1,
  );
  const { ctx, page } = await open('lucia', {
    stub: (d) => {
      const m = d.movements.find((x) => x.id === target.id);
      Object.assign(m.category, {
        id: 'other',
        state: 'needs_review',
        source: 'none',
        reason: 'no_decider',
      });
    },
  });
  const posts = [];
  await page.route('**/api/insights/categories', (route) => {
    posts.push(route.request().postDataJSON());
    return json(route, { updated: 1, similar: [], rules: [] });
  });
  await viewAll(page);
  const keep = rowOf(page, target.description).getByRole('button', { name: /^Keep as Other: / });
  await keep.focus();
  await page.keyboard.press('Enter');
  await page.waitForResponse((r) => r.url().endsWith('/api/insights/categories'));
  check(
    'a movement in review has "Keep as Other": it posts the row\'s ids with `other`; only rows in review have it',
    JSON.stringify(posts) === JSON.stringify([{ movementIds: [target.id], category: 'other' }]) &&
      (await page.getByRole('button', { name: /^Keep as Other/ }).count()) ===
        (await page.locator('[data-testid="category-chip"][data-state="needs_review"]').count()),
    JSON.stringify(posts),
  );
  await ctx.close();
});

// IT6 (A9): the select only fires on a change, so a right estimate has its own button.
await run('Correct (stubbed)', async () => {
  const target = dash.movements.find(
    (m) =>
      m.category?.movementIds.length === 1 &&
      m.amountCents < 0 &&
      // FX1: a transfer the app knows it sent is titled by its counterparty, not this text.
      !m.toAccountId &&
      dash.movements.filter((x) => x.description === m.description).length === 1,
  );
  const { ctx, page } = await open('lucia', {
    stub: (d) => {
      const m = d.movements.find((x) => x.id === target.id);
      Object.assign(m.category, { id: 'shopping', state: 'estimated', source: 'rule' });
    },
  });
  const posts = [];
  let refuse = false;
  await page.route('**/api/insights/categories', (route) => {
    posts.push(route.request().postDataJSON());
    return refuse
      ? json(route, { error: 'ZZQXV refused.' }, 400)
      : json(route, { updated: 1, similar: [], rules: [] });
  });
  await viewAll(page);
  const row = rowOf(page, target.description);
  const correct = row.getByRole('button', {
    name: `Confirm Shopping for ${target.description}`,
    exact: true,
  });
  await correct.focus();
  await page.keyboard.press('Enter');
  await page.waitForResponse((r) => r.url().endsWith('/api/insights/categories'));
  check(
    'IT6 A9 an estimate has "Confirm": by keyboard it posts the row\'s ids with its current category; only estimates have it',
    (await correct.innerText()) === 'Confirm' &&
      JSON.stringify(posts) ===
        JSON.stringify([{ movementIds: [target.id], category: 'shopping' }]) &&
      (await page.getByRole('button', { name: /^Confirm .+ for / }).count()) ===
        (await page.locator('[data-testid="category-chip"][data-state="estimated"]').count()),
    JSON.stringify(posts),
  );
  refuse = true;
  await page.locator('[data-testid="spending-card"][aria-busy="false"]').waitFor();
  await correct.click();
  const alert = row.locator('.si-feedback [role="alert"]');
  await alert.waitFor();
  check(
    'IT6 A9 a refused "Confirm" is reported in the row and nothing is shown as confirmed',
    (await alert.innerText()) === 'ZZQXV refused.' &&
      (await row.getByTestId('category-chip').getAttribute('data-state')) === 'estimated',
    await alert.innerText(),
  );
  await ctx.close();
});

await run('Retry (stubbed)', async () => {
  const { ctx, page } = await open('lucia', {
    stub: (d) => {
      d.insights.unresolved = {
        count: 2,
        totalCents: 3000,
        groups: [
          {
            merchantKey: 'ZZQXV GAMMA',
            title: 'ZZQXV GAMMA',
            count: 2,
            totalCents: 3000,
            movementIds: ['g1', 'g2'],
            candidates: [],
            reason: 'decider_unavailable',
          },
        ],
      };
    },
  });
  let posted = 0;
  await page.route('**/api/insights/reclassify', (route) => {
    posted++;
    return json(route, { queued: 2 });
  });
  const line = page.locator('.spend-insights .si-retry');
  await line.waitFor();
  await line.getByRole('button', { name: 'Try again' }).click();
  await page.locator('.spend-insights [role="status"]', { hasText: 'Trying again' }).waitFor();
  check(
    '"Try again" when the classifier did not answer posts the reclassify route',
    /^The classifier did not answer for 2 movements\./.test(await line.innerText()) && posted === 1,
  );
  await ctx.close();
});

await run('No insights', async () => {
  const old = await open('lucia', {
    stub: (d) => {
      delete d.insights;
      for (const m of d.movements) delete m.category;
    },
  });
  await old.page.locator('.movements .movement').first().waitFor();
  check(
    'a dashboard without insights renders Overview as before (no slot, no chip, old columns)',
    (await old.page.getByTestId('overview-insights').count()) === 0 &&
      (await old.page.getByTestId('category-chip').count()) === 0 &&
      (await old.page.locator('.movements.has-row-extra').count()) === 0,
  );
  await old.ctx.close();
  const op = await open('marta');
  check(
    'nothing for the operator',
    (await op.page.getByTestId('spending-card').count()) === 0 &&
      (await op.page.getByTestId('category-chip').count()) === 0,
  );
  await op.ctx.close();
});

await run('Widths', async () => {
  for (const width of [1440, 1280, 390]) {
    const { ctx, page, errors } = await open('bruno', { viewport: { width, height: 900 } });
    await page.getByTestId('spending-card').waitFor();
    await viewAll(page);
    await page.getByTestId('category-chip').first().click();
    const over = await overflow(page);
    const bad = errors.filter((e) => HYDRATION.test(e) || !/Failed to load resource/.test(e));
    check(
      `REQ-SI7-12 ${width} px: no horizontal overflow, no console error or hydration warning`,
      over <= 0 && bad.length === 0,
      `overflow ${over}px${bad.length ? ` · ${bad.join(' | ').slice(0, 200)}` : ''}`,
    );
    await page.screenshot({ path: `${SHOTS}/si7a-bruno-${width}.png`, fullPage: true });
    if (width === 390) {
      // Review of #101: on a phone the select is a 44 px target, and all of it answers a tap.
      const select = page.getByTestId('category-select').nth(2);
      await select.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      const box = await select.boundingBox();
      const hits = await page.evaluate(
        (b) =>
          [
            [b.x + 2, b.y + 2],
            [b.x + b.width - 2, b.y + 2],
            [b.x + 2, b.y + b.height - 2],
            [b.x + b.width - 2, b.y + b.height - 2],
            [b.x + b.width / 2, b.y + b.height / 2],
          ].map(([x, y]) => document.elementFromPoint(x, y)?.dataset.testid),
        box,
      );
      check(
        '390 px: the select is a touch target of at least 44 × 44 px, not covered',
        box.width >= 44 && box.height >= 44 && hits.every((h) => h === 'category-select'),
        `${Math.round(box.width)} × ${Math.round(box.height)} · ${hits.join()}`,
      );
    }
    await ctx.close();
  }
});

// The real flow, end to end, on the demo bank: Bruno's four ESPAI NOU movements.
if (!demo)
  console.log(
    'SKIP demo bank: review list, ESPAI NOU rule, Undo, rule removal, a group that offers the rule, "Confirm" — not the demo bank',
  );
else
  await run('Demo bank', async () => {
    const { ctx, page, dashboard } = await open('bruno');
    const espai = page.locator('[data-testid="unresolved-group"][data-merchant="ESPAI NOU"]');
    await espai.waitFor();
    check(
      'demo: the review list is not empty on first load; ESPAI NOU has four',
      (await page.getByTestId('unresolved-group').count()) >= 2 &&
        /4 movements · €60\.00/.test(await espai.innerText()),
      (await espai.innerText()).replace(/\s+/g, ' '),
    );
    await viewAll(page);
    const rows = page.locator('.movements .movement', { hasText: 'ESPAI NOU' });
    const state = () =>
      rows
        .getByTestId('category-chip')
        .evaluateAll((els) => els.map((e) => e.dataset.state).join());
    const row = rows.first();
    await row.getByTestId('category-select').selectOption('eating_out_leisure');
    const offer = row.locator('.si-feedback [role="status"]');
    await offer.waitFor();
    check(
      'demo: one row set by hand; the offer names the three others',
      (await offer.innerText()) ===
        'Apply Eating out & leisure to the 3 other ESPAI NOU movements and to future ones?' &&
        (await state()) === 'confirmed,needs_review,needs_review,needs_review',
      await state(),
    );
    await row.getByTestId('similar-offer-yes').click();
    const notice = row.getByTestId('insights-notice');
    await notice.waitFor();
    await page.locator('[data-testid="rule-item"][data-merchant="ESPAI NOU"]').waitFor();
    check(
      'demo: "Yes" learns the rule: notice, four confirmed, rule listed, group gone',
      (await notice.innerText()).startsWith(
        'Learned: ESPAI NOU is Eating out & leisure. 3 movements updated.',
      ) &&
        (await state()) === 'confirmed,confirmed,confirmed,confirmed' &&
        (await espai.count()) === 0,
      await state(),
    );
    await page.screenshot({ path: `${SHOTS}/si7a-demo-learned-1440.png`, fullPage: true });
    await row.getByTestId('insights-undo').click();
    await page.getByTestId('rule-item').waitFor({ state: 'detached' });
    await espai.waitFor();
    check(
      'demo REQ-SI7-7: Undo removes the rule; its three movements are back in review, the hand-set one stays',
      (await state()) === 'confirmed,needs_review,needs_review,needs_review' &&
        /3 movements · €45\.00/.test(await espai.innerText()),
      await state(),
    );
    // A second row makes the rule again; it is still there after a reload; "Remove" deletes it.
    const second = rows.nth(1);
    await second.getByTestId('category-select').selectOption('eating_out_leisure');
    await second.getByTestId('similar-offer-yes').click();
    const rule = page.locator('[data-testid="rule-item"][data-merchant="ESPAI NOU"]');
    await rule.waitFor();
    await page.reload();
    await rule.waitFor();
    check(
      'demo REQ-SI7-7: the rule is listed, also after a reload',
      /ESPAI NOU.*Eating out & leisure/s.test(await rule.innerText()),
    );
    await rule.getByTestId('rule-remove').click();
    await rule.waitFor({ state: 'detached' });
    await espai.waitFor();
    const sources = async () =>
      (await dashboard()).movements
        .filter((m) => m.category.merchantKey === 'ESPAI NOU')
        .map((m) => `${m.category.state}/${m.category.source}`)
        .sort()
        .join();
    check(
      'demo REQ-SI7-7: "Remove" deletes the rule; its movements are back in review, hand-set ones stay',
      (await (await ctx.request.get(`${URL}/api/insights/rules`)).json()).rules.length === 0 &&
        (await sources()) === 'confirmed/user,confirmed/user,needs_review/none,needs_review/none',
      await sources(),
    );
    // IT6 (A8): from the review list, the whole group at once. No other movement is left, so the
    // offer is for the future only; nothing is learned before "Yes".
    await espai.getByLabel('Category for ESPAI NOU').selectOption('eating_out_leisure');
    const line = page.locator('.spend-insights > .si-feedback');
    await line.getByTestId('similar-offer-yes').waitFor();
    const asked = await line.locator('[role="status"]').innerText();
    check(
      'demo IT6 A8: a group set from the review list is confirmed by hand and offers the rule for the future; no rule yet',
      asked === 'Remember this for future ESPAI NOU movements?' &&
        (await sources()) === 'confirmed/user,confirmed/user,confirmed/user,confirmed/user' &&
        (await espai.count()) === 0 &&
        (await (await ctx.request.get(`${URL}/api/insights/rules`)).json()).rules.length === 0,
      `${asked} · ${await sources()}`,
    );
    await page.screenshot({ path: `${SHOTS}/it6-demo-group-offer-1440.png`, fullPage: true });
    await page.locator('[data-testid="spending-card"][aria-busy="false"]').waitFor();
    await line.getByTestId('similar-offer-yes').click();
    const learned = line.getByTestId('insights-notice');
    await learned.waitFor();
    await rule.waitFor();
    check(
      'demo IT6 A8: "Yes" makes the rule: notice with Undo, rule listed',
      (await learned.innerText()).startsWith('Learned: ESPAI NOU is Eating out & leisure.') &&
        (await (await ctx.request.get(`${URL}/api/insights/rules`)).json()).rules.length === 1,
      await learned.innerText(),
    );
    await page.screenshot({ path: `${SHOTS}/it6-demo-group-learned-1440.png`, fullPage: true });
    await learned.getByTestId('insights-undo').click();
    await rule.waitFor({ state: 'detached' });
    const undone = await line.locator('[role="status"]').innerText();
    check(
      'demo IT6 A8: Undo removes the rule only; the movements set by hand stay',
      (await sources()) === 'confirmed/user,confirmed/user,confirmed/user,confirmed/user' &&
        (await espai.count()) === 0 &&
        undone === 'Rule for ESPAI NOU removed. 0 movements classified again.',
      `${undone} · ${await sources()}`,
    );
    // IT6 (A8): a group without a merchant key cannot have a rule: the API answers `similar: []`,
    // so nothing is offered and the card keeps the honest line.
    const paypal = page.locator('[data-testid="unresolved-group"][data-merchant=""]', {
      hasText: 'PAYPAL *JGARCIA88',
    });
    await paypal.getByLabel('Category for PAYPAL *JGARCIA88').selectOption('shopping');
    await paypal.waitFor({ state: 'detached' });
    const said = await page.locator('.spend-insights > .si-feedback [role="status"]').innerText();
    check(
      'demo IT6 A8: a group with no merchant key is set: no offer, no rule, "Only these…"',
      said === '1 movement set to Shopping. Only these: no rule was made for future ones.' &&
        (await page.getByTestId('insights-notice').count()) === 0 &&
        (await page.getByTestId('similar-offer-yes').count()) === 0 &&
        (await (await ctx.request.get(`${URL}/api/insights/rules`)).json()).rules.length === 0,
      said,
    );
    // IT6 (A9): a right estimate is confirmed from its row; the confirmed part of the bar grows.
    const eatingOut = async () =>
      (await dashboard()).insights.categories.find((c) => c.id === 'eating_out_leisure')
        .confirmedCents;
    const before = await eatingOut();
    await viewAll(page);
    const bar = rowOf(page, 'CERVECERIA EL CABANYAL').filter({ hasText: '24.50' }); // three since DS3
    const chip = bar.getByTestId('category-chip');
    const was = `${await chip.innerText()}/${await chip.getAttribute('data-state')}`;
    await bar
      .getByRole('button', { name: 'Confirm Eating out & leisure for CERVECERIA EL CABANYAL' })
      .click();
    await bar.locator('[data-testid="category-chip"][data-state="confirmed"]').waitFor();
    await page.screenshot({ path: `${SHOTS}/it6-demo-correct-1440.png`, fullPage: true });
    await page.reload();
    await page.getByTestId('spending-card').waitFor();
    await viewAll(page);
    check(
      'demo IT6 A9: "Confirm" confirms the estimate as it is (source user), also after a reload; the confirmed amount grows',
      was === 'Eating out & leisure · estimated/estimated' &&
        (await chip.innerText()) === 'Eating out & leisure' &&
        (await chip.getAttribute('data-state')) === 'confirmed' &&
        (await chip.getAttribute('data-source')) === 'user' &&
        (await bar.getByRole('button', { name: /^Confirm / }).count()) === 0 &&
        (await eatingOut()) === before + 2450,
      `${was} → ${await chip.innerText()}/${await chip.getAttribute('data-source')} · confirmed ${before} → ${await eatingOut()}`,
    );
    // Review of #101: "this really is Other" from the row, for a movement in review. CAT1: Bruno's
    // CUOTA AUTONOMOS TGSS is now Work & projects by rule, and his other groups are set above, so
    // the check runs on Omar's two APPLE.COM/BILL payments (left to review: Apple can be personal).
    const omar = await open('omar');
    await omar.page.getByTestId('spending-card').waitFor();
    await viewAll(omar.page);
    const apple = rowOf(omar.page, 'APPLE.COM/BILL ITUNES.COM IE').first();
    const group = omar.page.locator('[data-testid="unresolved-group"]', { hasText: 'APPLE' });
    await apple.getByRole('button', { name: /^Keep as Other: / }).click();
    await apple.locator('[data-testid="category-chip"][data-state="confirmed"]').waitFor();
    await omar.page.reload();
    await omar.page.getByTestId('spending-card').waitFor();
    await viewAll(omar.page);
    const kept = apple.getByTestId('category-chip');
    check(
      'demo: "Keep as Other" confirms Other, takes the movement out of the review list, survives a reload',
      (await kept.innerText()) === 'Other' &&
        (await kept.getAttribute('data-state')) === 'confirmed' &&
        (await apple.getByRole('button', { name: /^Keep as Other/ }).count()) === 0 &&
        /1 movement · €2\.99/.test(await group.innerText()),
      `${await kept.innerText()} · ${(await group.innerText()).replace(/\s+/g, ' ')}`,
    );
    await omar.ctx.close();
    await ctx.close();
  });

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
