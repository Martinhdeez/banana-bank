// Acceptance suite for the spend-insights UI (SI7-slots, SI7a, SI7b): REQ-SI7-1 … REQ-SI7-12 of
// docs/plan/23-spend-insights/requirements.md. Written from requirements.md, contracts.md (§3 HTTP
// shapes, §7 test server, §8 DOM hooks) and the visible texts of 07-si7-ui.md only; the author has
// not seen the implementation. The builders never edit this file.
//
// Server (contracts.md §7): the alt bank with the demo seed and ALT_BANK_MOVEMENTS_LIMIT=100, the
// app with BANK_EXTERNAL=1 and DECIDER=none. No model call: chat POSTs are stubbed with page.route.
// On another bank (no `demo-` movement id) the live scenarios print one SKIP line each and the
// stubbed scenarios still run, so `npm run e2e` stays usable on the simulator.
//
// Live scenarios change only movements this run injects (`ZZQXV <letters>`, contracts.md §1), so
// the suite can run again on the same data directory. They are left in the bank.
//
// Run: APP_URL=http://127.0.0.1:3940 BANK_URL=http://127.0.0.1:4940 \
//        node tests/e2e/acceptance-si7-insights-ui.e2e.mjs
// STEP_TIMEOUT_MS (default 5000): wait per step. PLAYWRIGHT_MODULE / PLAYWRIGHT_CHANNEL / SHOTS as
// in the other e2e scripts.
import { APP_URL as URL, launch, SHOTS, requireBankUrl, requireSeed } from './env.mjs';
const BANK = requireBankUrl();
await requireSeed(URL);
const CONTROL = process.env.ALT_BANK_CONTROL_TOKEN || 'alt-control';
const T = Number(process.env.STEP_TIMEOUT_MS || 5000);
const browser = await launch();

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
// One check per step: a step that throws (absent element, timeout) fails alone.
async function t(name, fn) {
  try {
    const r = await fn();
    const [ok, detail] = Array.isArray(r) ? r : [r];
    check(name, !!ok, String(detail ?? '').slice(0, 300));
    return !!ok;
  } catch (e) {
    check(name, false, `threw: ${e.message.split('\n')[0]}`);
    return false;
  }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = T) => {
  for (const end = Date.now() + ms; Date.now() < end; await pause(100)) if (await fn()) return true;
  return false;
};
const json = (route, status, body) =>
  route
    .fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    .catch(() => {});
const tid = (root, id) => root.locator(`[data-testid="${id}"]`);
// The period dropdown of the spending card (contracts.md 2.22, §8; reconciled by the reviewer of
// #136, a third party): open it with `spending-period`, click the option for `value`, wait until
// the button carries that value (`data-period`, the value sent; the menu closes after a choice)
// and the card is no longer busy. A month is clicked in the month grid, by its name ("Sep 2026"):
// the quick choice "Last month" carries the same `data-period`.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
async function pickPeriod(card, value) {
  const menu = tid(card, 'spending-period-menu');
  if (!(await menu.count())) await tid(card, 'spending-period').click();
  let option = menu.locator(`[data-testid="spending-period-option"][data-period="${value}"]`);
  if (/^\d{4}-\d{2}$/.test(value)) {
    const year = menu.locator('[aria-live]');
    for (let i = 0; i < 20 && (await year.innerText()).trim() !== value.slice(0, 4); i++)
      await menu
        .getByRole('button', {
          name: (await year.innerText()).trim() > value.slice(0, 4) ? 'Previous year' : 'Next year',
        })
        .click();
    option = option.and(
      menu.getByRole('button', {
        name: `${MONTHS[Number(value.slice(5)) - 1]} ${value.slice(0, 4)}`,
        exact: true,
      }),
    );
  }
  await option.click();
  await card.locator(`[data-testid="spending-period"][data-period="${value}"]`).waitFor();
  await card.page().locator('[data-testid="spending-card"][aria-busy="false"]').waitFor();
}
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const euros = (c) => `€${(Math.abs(c) / 100).toFixed(2)}`;
// Every money amount in a text, as signed cents ("-€14.00", "+€2,150.00", "€5.00").
const amounts = (text) =>
  [...text.matchAll(/([-−+]?)\s?€\s?([\d,]+\.\d{2})/g)].map(
    (m) => (/[-−]/.test(m[1]) ? -1 : 1) * Math.round(parseFloat(m[2].replace(/,/g, '')) * 100),
  );

// contracts.md §1 (taxonomy) and §8 (chip text).
const LABEL = {
  groceries: 'Groceries',
  eating_out_leisure: 'Eating out & leisure',
  transport: 'Transport',
  home_utilities: 'Home & utilities',
  health: 'Health',
  shopping: 'Shopping',
  work: 'Work & projects',
  transfer_person: 'Transfers to people',
  savings_internal: 'Savings / own transfer',
  income: 'Income',
  other: 'Other',
};
const IDS = Object.keys(LABEL);
const chipText = (c) =>
  c.state === 'estimated'
    ? `${LABEL[c.category]} · estimated`
    : c.state === 'confirmed'
      ? LABEL[c.category]
      : c.state === 'needs_review'
        ? 'Other · to review'
        : c.state === 'pending'
          ? 'Classifying…'
          : null;
const FEATURE_IDS = [
  'overview-insights',
  'spending-card',
  'spending-category',
  'spending-window-note',
  'unresolved-group',
  'category-chip',
  'category-select',
  'category-ask',
  'rule-item',
  'attached-movement',
  'quick-reply',
];
const anyFeature = FEATURE_IDS.map((id) => `[data-testid="${id}"]`).join(',');

async function open(
  persona,
  {
    tab = 'overview',
    viewport = { width: 1440, height: 900 },
    routes,
    ready = '.account-card',
  } = {},
) {
  const ctx = await browser.newContext({ viewport });
  await ctx.request.post(`${URL}/api/session`, { data: { userId: persona } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(T);
  const errors = [];
  page.on(
    'console',
    (m) => (m.type() === 'error' || /hydrat/i.test(m.text())) && errors.push(m.text()),
  );
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript((p) => localStorage.setItem('banana_person', p), persona);
  if (routes) await routes(page);
  await page.goto(`${URL}/?tab=${tab}`);
  if (ready) await page.waitForSelector(ready, { timeout: 20_000 });
  return { ctx, page, errors };
}
const api = (page, path) => page.evaluate(async (p) => (await fetch(p)).json(), path);
async function viewAll(page) {
  const b = page.getByRole('button', { name: 'View all' });
  if (await b.count()) await b.click();
}
async function toOverview(page) {
  await page.goto(`${URL}/?tab=overview`);
  await page.waitForSelector('.account-card', { timeout: 20_000 });
  await viewAll(page);
}
const active = (page) => page.locator('nav button[aria-current="page"]').innerText();
const rowOf = (page, cents) => page.locator('.movements .movement', { hasText: euros(cents) });
const chipOf = async (row) => {
  const chip = tid(row, 'category-chip');
  return {
    category: await chip.getAttribute('data-category'),
    state: await chip.getAttribute('data-state'),
  };
};
// Every movement row as data. The chip text leaves out the controls a chip may contain.
const rows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.movements .movement')].map((row) => {
      const chips = row.querySelectorAll('[data-testid="category-chip"]');
      let text = '';
      if (chips[0]) {
        const c = chips[0].cloneNode(true);
        c.querySelectorAll(
          'select, .sr-only, [data-testid="category-why"], [data-testid="category-ask"]',
        ).forEach((e) => e.remove());
        text = c.textContent.replace(/\s+/g, ' ').trim();
      }
      return {
        proposal: /\b(pending|verifying)\b/.test(row.className),
        chips: chips.length,
        asks: row.querySelectorAll('[data-testid="category-ask"]').length,
        dates: row.querySelectorAll('small').length,
        category: chips[0]?.dataset.category,
        state: chips[0]?.dataset.state,
        text,
        amount: row.querySelector('.amount')?.textContent ?? '',
        title: row.querySelector('strong')?.textContent ?? '',
      };
    }),
  );
// 07: the "why" line is shown on focus or tap of the chip.
async function whyOf(row) {
  const chip = tid(row, 'category-chip').first();
  const why = tid(row, 'category-why').first();
  await chip.focus();
  if (!(await why.isVisible().catch(() => false))) await chip.click();
  await why.waitFor({ state: 'visible' });
  return norm(await why.innerText());
}
// 07: the chip opens a native select.
async function selectOf(row) {
  const select = tid(row, 'category-select').first();
  if (!(await select.isVisible().catch(() => false)))
    await tid(row, 'category-chip').first().click();
  await select.waitFor({ state: 'visible' });
  return select;
}
const optionsOf = async (row) =>
  (await selectOf(row)).evaluate((s) => [...s.options].map((o) => o.value).filter(Boolean));
// Chooses a category and returns the body of the POST it caused.
async function pick(page, row, category) {
  const select = await selectOf(row);
  const [request] = await Promise.all([
    page.waitForRequest(
      (r) => r.method() === 'POST' && r.url().endsWith('/api/insights/categories'),
    ),
    select.selectOption(category),
  ]);
  return request.postDataJSON();
}
const postsTo = (page, suffix, method = 'POST') => {
  const seen = [];
  page.on('request', (r) => {
    if (r.method() === method && new globalThis.URL(r.url()).pathname.includes(suffix))
      seen.push({
        path: new globalThis.URL(r.url()).pathname,
        body: r.postData() ? r.postDataJSON() : null,
      });
  });
  return seen;
};
// 07 redesign rules: native controls, type="button", an accessible name, reachable with Tab.
const a11y = (page, ids) =>
  page.evaluate((ids) => {
    const name = (el) =>
      (
        el.getAttribute('aria-label') ||
        (el.getAttribute('aria-labelledby') || '')
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || '')
          .join(' ')
          .trim() ||
        [...(el.labels ?? [])].map((l) => l.textContent).join(' ') ||
        (el.tagName === 'SELECT' ? '' : el.textContent) ||
        el.title ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim();
    const issues = [];
    const found = {};
    for (const id of ids) {
      const els = [...document.querySelectorAll(`[data-testid="${id}"]`)];
      found[id] = els.length;
      for (const el of els.slice(0, 5)) {
        if (!['BUTTON', 'SELECT'].includes(el.tagName)) issues.push(`${id} is a ${el.tagName}`);
        if (el.tagName === 'BUTTON' && el.type !== 'button') issues.push(`${id} type=${el.type}`);
        if (!name(el)) issues.push(`${id} has no accessible name`);
        if (el.tabIndex < 0) issues.push(`${id} is not in the tab order`);
      }
    }
    return { issues: [...new Set(issues)], found };
  }, ids);
const overflow = (page, width) =>
  page.evaluate((width) => {
    const out = [];
    for (const el of document.querySelectorAll(
      '[data-testid="spending-card"], [data-testid="category-chip"], [data-testid="category-ask"], [data-testid="unresolved-group"], [data-testid="rule-item"]',
    )) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.right > width + 0.5 || r.left < -0.5))
        out.push(`${el.dataset.testid} ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
    return { scrollWidth: document.documentElement.scrollWidth, out: [...new Set(out)] };
  }, width);

// ---- Stubbed dashboard: the real answer with `category` and `insights` of contracts.md §3 ----
const MODEL = 'systemone:jev-1.13.0';
const STUB_KEY = 'ZZQXV STUB';
const cat = (id, state, source, reason, extra = {}) => ({
  id,
  state,
  source,
  reason,
  confidence: null,
  threshold: null,
  candidates: [],
  merchantKey: '',
  model: null,
  ...extra,
});
function summarise(movs) {
  const cats = new Map();
  const groups = new Map();
  let incomeCents = 0;
  let pending = 0;
  for (const m of movs) {
    const c = m.category;
    if (c.state === 'pending') pending++;
    if (m.amountCents > 0 && c.id === 'income') incomeCents += m.amountCents;
    const spend =
      c.id !== 'savings_internal' && c.id !== 'income' && !(m.amountCents > 0 && c.id === 'other');
    if (spend) {
      const row = cats.get(c.id) ?? {
        id: c.id,
        label: LABEL[c.id],
        spentCents: 0,
        count: 0,
        confirmedCents: 0,
        estimatedCents: 0,
      };
      row.spentCents -= m.amountCents;
      row[c.state === 'confirmed' ? 'confirmedCents' : 'estimatedCents'] -= m.amountCents;
      row.count++;
      cats.set(c.id, row);
    }
    if (c.state === 'needs_review') {
      const key = c.merchantKey || m.id;
      const g = groups.get(key) ?? {
        merchantKey: c.merchantKey,
        title: c.merchantKey,
        count: 0,
        totalCents: 0,
        movementIds: [],
        candidates: c.candidates,
        reason: c.reason,
      };
      g.count++;
      g.totalCents -= m.amountCents;
      g.movementIds.push(m.id);
      groups.set(key, g);
    }
  }
  const categories = [...cats.values()].sort((a, b) => b.spentCents - a.spentCents);
  const list = [...groups.values()].sort((a, b) => b.totalCents - a.totalCents);
  const dates = movs
    .map((m) => m.createdAt)
    .filter(Boolean)
    .sort();
  return {
    range: { from: null, to: null },
    window: { returned: movs.length, oldestAt: dates[0] ?? null, mayBeTruncated: false },
    partial: false,
    spentCents: categories.reduce((s, c) => s + c.spentCents, 0),
    incomeCents,
    categories,
    unresolved: {
      count: list.reduce((s, g) => s + g.count, 0),
      totalCents: list.reduce((s, g) => s + g.totalCents, 0),
      groups: list,
    },
    pending,
    decider: 'none',
  };
}
function fixture(body, kind) {
  const movs = body.movements ?? [];
  const legs = {};
  for (const m of movs) if (m.operationId) (legs[m.operationId] ??= []).push(m);
  for (const m of movs) {
    const pair = m.operationId && legs[m.operationId].length === 2 ? legs[m.operationId] : null;
    m.category = pair
      ? cat('savings_internal', 'estimated', 'rule', 'own_account')
      : m.amountCents > 0
        ? cat('income', 'estimated', 'rule', 'credit')
        : kind === 'empty'
          ? cat('savings_internal', 'estimated', 'rule', 'own_account')
          : cat('shopping', 'estimated', 'rule', 'keyword:STUB SHOP', { merchantKey: 'STUB SHOP' });
    m.category.movementIds = pair ? pair.map((l) => l.id) : [m.id];
  }
  const free = movs.filter((m) => m.category.id === 'shopping');
  const set = (list, c) => list.forEach((m) => (m.category = { ...c, movementIds: [m.id] }));
  if (kind === 'groups')
    set(
      free.slice(0, 3),
      cat('other', 'needs_review', 'model', 'below_threshold', {
        confidence: 0.48,
        threshold: 0.8,
        candidates: [
          { category: 'shopping', p: 0.48 },
          { category: 'health', p: 0.3 },
        ],
        merchantKey: STUB_KEY,
        model: MODEL,
      }),
    );
  if (kind === 'model')
    set(
      free.slice(0, 1),
      cat('health', 'estimated', 'model', 'model', {
        confidence: 0.91,
        threshold: 0.8,
        candidates: [
          { category: 'health', p: 0.91 },
          { category: 'groceries', p: 0.05 },
        ],
        merchantKey: STUB_KEY,
        model: MODEL,
      }),
    );
  if (kind === 'pending') set(free.slice(0, 2), cat('other', 'pending', 'none', 'pending'));
  if (kind === 'unavailable')
    set(
      free.slice(0, 1),
      cat('other', 'needs_review', 'none', 'decider_unavailable', { merchantKey: STUB_KEY }),
    );
  body.insights = summarise(movs);
  return body;
}
const RULES = [
  {
    merchantKey: 'ESPAI NOU',
    category: 'eating_out_leisure',
    createdAt: '2026-10-01T10:00:00.000Z',
  },
  { merchantKey: 'LA ESQUINA', category: 'groceries', createdAt: '2026-09-30T10:00:00.000Z' },
];
// Returns what the page saw and asked for. Every insights route is answered here, not by the app.
const stubbed = (kind, state) => async (page) => {
  await page.route('**/api/dashboard', async (route) => {
    const res = await route.fetch();
    const body = fixture(await res.json(), kind);
    state.dashboards++;
    state.insights = body.insights;
    await route.fulfill({ response: res, json: body }).catch(() => {});
  });
  await page.route('**/api/insights/rules', (route) =>
    json(route, 200, { rules: kind === 'groups' ? RULES : [] }),
  );
  await page.route('**/api/insights/rules/*', (route) => {
    state.calls.push({ method: route.request().method(), path: route.request().url() });
    return json(route, 200, { removed: true, reclassified: 2 });
  });
  await page.route('**/api/insights/reclassify', (route) => {
    state.calls.push({ method: 'POST', path: route.request().url() });
    return json(route, 200, { queued: 1 });
  });
  await page.route('**/api/insights/categories', (route) => {
    const body = route.request().postDataJSON();
    state.sets.push(body);
    const ids = state.insights.unresolved.groups[0]?.movementIds ?? [];
    return json(
      route,
      200,
      body.applyToSimilar
        ? { updated: 3, similar: [], rules: [STUB_KEY] }
        : {
            updated: body.movementIds.length,
            similar: [{ merchantKey: STUB_KEY, count: 2, movementIds: ids.slice(0, 2) }],
            rules: [],
          },
    );
  });
};
const newState = () => ({ dashboards: 0, insights: null, calls: [], sets: [] });
async function scenario(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(`${name} (scenario)`, false, `threw: ${e.message.split('\n')[0]}`);
  }
}

// ---- Which bank is this? ----
const probe = await open('lucia');
const firstDash = await api(probe.page, '/api/dashboard');
const DEMO = (firstDash.movements ?? []).some((m) => String(m.id).startsWith('demo-'));
await probe.ctx.close();
const skipped = [];
const live = (name, fn) => {
  if (DEMO) return scenario(name, fn);
  skipped.push(name);
  console.log(`SKIP ${name} — needs the seeded alt bank (contracts.md §7): no demo- id`);
};

// ================= Guards: existing UI (pass before the feature exists) =================
await scenario('guards', async () => {
  const { ctx, page, errors } = await open('lucia');
  await viewAll(page);
  await t(
    'REQ-SI7-1 guard: Overview keeps its structure (accounts, one date per row)',
    async () => {
      const r = await rows(page);
      return [
        r.length > 0 &&
          r.every((x) => x.dates === 1) &&
          (await page.locator('.account-card').count()) > 0,
        `rows=${r.length}`,
      ];
    },
  );
  await t('REQ-SI7-12 guard: 1440 px Overview has no horizontal overflow', async () => {
    const o = await overflow(page, 1440);
    return [o.scrollWidth <= 1440, `scrollWidth=${o.scrollWidth}`];
  });
  await page.waitForLoadState('networkidle');
  await t('REQ-SI7-12 guard: no console error or hydration warning on Overview', () => [
    errors.length === 0,
    errors.join(' | '),
  ]);
  await page.screenshot({ path: `${SHOTS}/acceptance-si7-overview-1440.png`, fullPage: true });
  await ctx.close();

  const phone = await open('lucia', { viewport: { width: 390, height: 844 } });
  await t('REQ-SI7-12 guard: 390 px Overview has no horizontal overflow', async () => {
    const o = await overflow(phone.page, 390);
    return [o.scrollWidth <= 390, `scrollWidth=${o.scrollWidth}`];
  });
  await phone.ctx.close();

  const chat = await open('lucia', { tab: 'assistant', ready: '.composer-box textarea' });
  await t(
    'REQ-SI7-1 guard: composer has no composer-extra wrapper with nothing attached',
    async () => [
      (await tid(chat.page, 'composer-extra').count()) === 0 &&
        (await chat.page.getByLabel('Message the assistant').count()) === 1,
    ],
  );
  await chat.ctx.close();

  const op = await open('marta', { ready: '.page-heading' });
  await t('OPERATOR (contracts §3) no category UI for the operator, on any tab', async () => {
    const seen = [];
    const tabs = op.page.locator('nav button');
    for (let i = 0; i < (await tabs.count()); i++) {
      await tabs.nth(i).click();
      await pause(400);
      const n = await op.page.locator(anyFeature).count();
      if (n) seen.push(`${norm(await tabs.nth(i).innerText())}: ${n}`);
    }
    return [seen.length === 0 && (await tabs.count()) > 0, seen.join(', ')];
  });
  await op.ctx.close();

  const state = newState();
  const calm = await open('lucia', { routes: stubbed('none', state) });
  await pause(1000);
  const before = state.dashboards;
  await pause(5000);
  await t(
    'REQ-SI7-11 guard: with nothing being classified the dashboard is not re-read within 5 s',
    () => [state.dashboards === before && before > 0, `requests ${before} → ${state.dashboards}`],
  );
  await calm.ctx.close();

  const down = await open('lucia', {
    ready: null,
    routes: (page) =>
      page.route('**/api/dashboard', (route) =>
        json(route, 503, { error: 'The bank is not available right now.' }),
      ),
  });
  await pause(2000);
  await t(
    'BANK-DOWN (contracts §3 "bank errors as today") a failed bank read shows no category figures and no crash',
    async () => [
      (await down.page
        .locator('[data-testid="spending-category"], [data-testid="category-chip"]')
        .count()) === 0 && !down.errors.some((e) => e.startsWith('pageerror')),
      down.errors.filter((e) => e.startsWith('pageerror')).join(' | '),
    ],
  );
  await down.ctx.close();
});

// ================= Live, read-only: Lucía and Bruno on the demo bank =================
await live('live overview (Lucía)', async () => {
  // IT8 (added by the reviewer of #127): the period header of the page's own dashboard reads.
  const asked = [];
  const { ctx, page, errors } = await open('lucia', {
    routes: (p) =>
      p.on(
        'request',
        (r) => r.url().endsWith('/api/dashboard') && asked.push(r.headers()['x-insights-period']),
      ),
  });
  const askedOnLoad = [...asked];
  await viewAll(page);
  const dash = await api(page, '/api/dashboard');
  const ins = dash.insights ?? { categories: [], unresolved: { groups: [] }, window: {} };
  const card = tid(page, 'spending-card');

  await t('REQ-SI7-1 the overview-insights slot holds the spending card', async () => [
    (await tid(tid(page, 'overview-insights'), 'spending-card').count()) === 1,
  ]);
  const r = await rows(page);
  const bank = r.filter((x) => !x.proposal);
  await t(
    'REQ-SI7-2 every bank movement row has one category-chip and one category-ask; proposal rows none',
    () => [
      bank.length > 0 &&
        bank.every((x) => x.chips === 1 && x.asks === 1) &&
        r.filter((x) => x.proposal).every((x) => x.chips === 0),
      `rows=${bank.length} with chip=${bank.filter((x) => x.chips === 1).length} with ask=${bank.filter((x) => x.asks === 1).length}`,
    ],
  );
  await t('REQ-SI7-2 each chip text matches its data-state and data-category', () => {
    const bad = bank.filter((x) => !x.chips || x.text !== chipText(x));
    return [
      bank.length > 0 && bad.length === 0,
      bad
        .slice(0, 3)
        .map((x) => `"${x.text}" [${x.category}/${x.state}]`)
        .join(' | '),
    ];
  });
  await t('REQ-SI7-2 the chips to review are the movements the dashboard has in review', () => {
    const n = bank.filter((x) => x.state === 'needs_review').length;
    return [n > 0 && n === ins.unresolved.count, `chips=${n} api=${ins.unresolved.count}`];
  });
  const own = page.locator('.movements .movement', { hasText: 'Between your accounts' }).first();
  await t(
    'REQ-SI7-2 an own-account transfer row reads "Savings / own transfer · estimated"',
    async () => {
      const c = await chipOf(own);
      return [c.category === 'savings_internal' && c.state === 'estimated', JSON.stringify(c)];
    },
  );
  await t('REQ-SI7-10 why: an own-account transfer says "Between your own accounts"', async () => {
    const why = await whyOf(own);
    return [why.includes('Between your own accounts'), why];
  });
  await t('REQ-SI7-10 why: a movement to review has a non-empty reason', async () => {
    const row = page
      .locator('.movements .movement', {
        has: page.locator('[data-testid="category-chip"][data-state="needs_review"]'),
      })
      .first();
    const why = await whyOf(row);
    return [why.length > 0, why];
  });

  // IT8 (contracts.md 2.17 and 2.19; added by the reviewer of #127, a third party).
  // DS2 reconciliation (contracts.md 2.30; a third party on PR #170). This check was "IT8 the card
  // opens on the current month, asked with x-insights-period: current". Since 2.30 the card opens
  // on the last full month: its first read asks for `last`, the month the server names becomes
  // the chosen period and is sent as that month from then on. The month is worked out here from
  // the server's `today` (the month before it; December of the year before in January), never
  // from this machine's clock or from what the card shows. Lucía's September figure is the
  // contract's (§7, 2.31). "This month" must still be one choice away, asked as `current`.
  // DS3 reconciliation (contracts.md 2.34; a third party on PR #183): Lucía's September is
  // €1,927.98 (192798; it was 160799), the figure of §7's first bullet, recomputed by the
  // reconciler from the seed rows alone (her September debits and the Team dinner, no refund;
  // .scratch/after/feat-ds3-realistic-demo-data/reconcile-recompute.mjs), not read from the app.
  const [todayYear, todayMonth] = ins.today.slice(0, 7).split('-').map(Number);
  const lastMonth =
    todayMonth === 1
      ? `${todayYear - 1}-12`
      : `${todayYear}-${String(todayMonth - 1).padStart(2, '0')}`;
  await t(
    'IT8 the card opens on the last full month, asked with x-insights-period: last; "This month" is still one choice away',
    async () => {
      const month = ins.today.slice(0, 7);
      const pressedIn = () =>
        tid(tid(card, 'spending-period-menu'), 'spending-period-option').evaluateAll((els) =>
          els.filter((e) => e.getAttribute('aria-pressed') === 'true').map((e) => e.dataset.period),
        );
      // The button says the value sent (`data-period`); the pressed options are in the opened
      // menu: the quick choice of last month and the cell of that month, both with its id.
      const sent = await tid(card, 'spending-period').getAttribute('data-period');
      await tid(card, 'spending-period').click();
      const pressed = await pressedIn();
      await page.keyboard.press('Escape');
      const closed = (await tid(card, 'spending-period-menu').count()) === 0;
      // The server answers `last` as that month, and the card shows that answer.
      const want = (
        await page.evaluate(async () =>
          (await fetch('/api/dashboard', { headers: { 'x-insights-period': 'last' } })).json(),
        )
      ).insights;
      const shown = amounts(await card.innerText());
      // "This month": one choice, asked as `current`; then back to the month the card opened on.
      const n = asked.length;
      await pickPeriod(card, 'current');
      const sentCurrent = asked.slice(n);
      await tid(card, 'spending-period').click();
      const pressedCurrent = await pressedIn();
      await page.keyboard.press('Escape');
      await pickPeriod(card, lastMonth);
      return [
        lastMonth < month &&
          sent === lastMonth &&
          pressed.join() === `${lastMonth},${lastMonth}` &&
          closed &&
          askedOnLoad[0] === 'last' &&
          askedOnLoad.every((h) => h === 'last' || h === lastMonth) &&
          want.period === lastMonth &&
          (lastMonth !== '2026-09' || want.spentCents === 192798) &&
          shown.includes(want.spentCents) &&
          sentCurrent.length > 0 &&
          sentCurrent.every((h) => h === 'current') &&
          pressedCurrent.join() === `current,${month}`,
        `data-period=${sent} pressed=${pressed} last=${lastMonth} today=${ins.today} headers=${askedOnLoad} api last=${want.period} ${want.spentCents}; this month: asked ${sentCurrent} pressed=${pressedCurrent}`,
      ];
    },
  );
  // IT8c-ui (contracts.md 2.21 and 2.22; added by the reviewer of #136, a third party).
  await t(
    "IT8c a preset and a month outside the bank's history are disabled and cannot be chosen",
    async () => {
      const n = asked.length;
      const first = ins.windowDays.from.slice(0, 7),
        last = ins.today.slice(0, 7);
      const menu = tid(card, 'spending-period-menu');
      const disabled = async () => {
        if (!(await menu.count())) await tid(card, 'spending-period').click();
        return tid(menu, 'spending-period-option').evaluateAll((els) =>
          els.filter((e) => e.disabled).map((e) => e.dataset.period),
        );
      };
      const off = await disabled();
      const months = off.filter((id) => /^\d{4}-\d{2}$/.test(id));
      // A press on a disabled option may close the menu: it is opened again for the next one.
      for (const id of off) {
        await disabled();
        await menu
          .locator(`[data-testid="spending-period-option"][data-period="${id}"]`)
          .click({ force: true });
        await pause(100);
      }
      await pause(400);
      if (await menu.count()) await page.keyboard.press('Escape');
      return [
        off.includes(String(Number(ins.today.slice(0, 4)) - 1)) &&
          months.length > 0 &&
          months.every((id) => id < first || id > last) &&
          // DS2 reconciliation (contracts.md 2.30): the period a refused choice leaves in place
          // is the default, the last full month (it was `current`).
          (await tid(card, 'spending-period').getAttribute('data-period')) === lastMonth &&
          asked.slice(n).every((h) => h === lastMonth),
        `disabled=${off} history=${first}…${last} asked after=${asked.slice(n)}`,
      ];
    },
  );
  await t(
    'IT8c a custom range applied through From and To makes the card equal dashboard.insights of that range',
    async () => {
      const from = ins.windowDays.from;
      const to = new Date(Date.parse(`${from}T00:00:00Z`) + 13 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const value = `${from}..${to}`;
      const n = asked.length;
      await tid(card, 'spending-period').click();
      await tid(card, 'spending-period-from').fill(from);
      await tid(card, 'spending-period-to').fill(to);
      await tid(card, 'spending-period-apply').click();
      await card.locator(`[data-testid="spending-period"][data-period="${value}"]`).waitFor();
      await page.locator('[data-testid="spending-card"][aria-busy="false"]').waitFor();
      // The page's own reads since Apply: the range as typed, with its literal "..".
      const sentByPage = asked.slice(n);
      const want = (
        await page.evaluate(
          async (v) =>
            (await fetch('/api/dashboard', { headers: { 'x-insights-period': v } })).json(),
          value,
        )
      ).insights;
      const shown = await tid(card, 'spending-category').evaluateAll((els) =>
        els.map((e) => [e.dataset.category, e.innerText]),
      );
      return [
        sentByPage.length > 0 &&
          sentByPage.every((h) => h === value) &&
          want.period === value &&
          want.spentCents > 0 &&
          want.spentCents !== ins.spentCents &&
          amounts(await card.innerText()).includes(want.spentCents) &&
          shown.length === want.categories.length &&
          want.categories.every(
            (c, i) => shown[i][0] === c.id && amounts(shown[i][1]).includes(c.spentCents),
          ) &&
          (await tid(card, 'spending-period-menu').count()) === 0,
        `${value}: api ${want.spentCents} in ${want.categories.length}; card rows ${shown.map((x) => x[0])}; asked ${sentByPage}`,
      ];
    },
  );
  // Reconciled to the period rule (contracts.md 2.19: the card shows the selected period, the
  // current month by default; the Transactions table is the whole window) by the reviewer of
  // #127: the REQ-SI7-3 checks below compare the card with the parameterless dashboard and with
  // the table, both the whole window, so "All" is selected first. No assertion changed.
  // Reconciled to the dropdown by the reviewer of #136: open, click, wait for the button's value
  // (it was a click on a visible segment and a wait for its pressed state).
  await pickPeriod(card, 'all');

  await t(
    'REQ-SI7-3 spending-card lists one spending-category per category with spend',
    async () => {
      const dom = await tid(card, 'spending-category').evaluateAll((els) =>
        els.map((e) => e.dataset.category).sort(),
      );
      const want = ins.categories.map((c) => c.id).sort();
      return [want.length > 0 && dom.join() === want.join(), `dom=${dom} api=${want}`];
    },
  );
  await t('REQ-SI7-3 each category amount and the total equal dashboard.insights', async () => {
    const bad = [];
    for (const c of ins.categories) {
      const text = await card
        .locator(`[data-testid="spending-category"][data-category="${c.id}"]`)
        .innerText();
      if (!amounts(text).includes(c.spentCents))
        bad.push(`${c.id}: ${norm(text)} ≠ ${c.spentCents}`);
    }
    const total = amounts(await card.innerText()).includes(ins.spentCents);
    return [
      ins.categories.length > 0 && bad.length === 0 && total,
      `total=${total} ${bad.join(' | ')}`,
    ];
  });
  await t(
    'REQ-SI7-3 each category amount equals the sum of the visible rows with that chip',
    async () => {
      const sums = {};
      for (const x of bank) {
        const [a] = amounts(x.amount);
        if (!x.category || ['savings_internal', 'income'].includes(x.category)) continue;
        if (a > 0 && x.category === 'other') continue; // opening rows and tax refunds: in no total
        sums[x.category] = (sums[x.category] ?? 0) - a;
      }
      const bad = [];
      const shown = await tid(card, 'spending-category').evaluateAll((els) =>
        els.map((e) => [e.dataset.category, e.innerText]),
      );
      for (const [id, text] of shown)
        if (!amounts(text).includes(sums[id]))
          bad.push(`${id}: card ${norm(text)} rows ${sums[id]}`);
      return [shown.length > 0 && bad.length === 0, bad.join(' | ')];
    },
  );
  await t('REQ-SI7-3 an estimated share is shown as "€X estimated"', async () => {
    const c = ins.categories.find((x) => x.estimatedCents > 0);
    const text = norm(
      await card.locator(`[data-testid="spending-category"][data-category="${c.id}"]`).innerText(),
    );
    return [/estimated/.test(text) && amounts(text).includes(c.estimatedCents), text];
  });
  await t('REQ-SI7-3 spending-window-note is present and names the movements covered', async () => {
    const text = norm(await tid(page, 'spending-window-note').innerText());
    const m = text.match(/Covers the (\d+) most recent movements the bank returned, since \S+/);
    return [!!m && Number(m[1]) === ins.window.returned, text];
  });

  await t(
    'REQ-SI7-4 one unresolved-group per merchant to review (at least 3 for Lucía)',
    async () => {
      const dom = await tid(page, 'unresolved-group').evaluateAll((els) =>
        els.map((e) => e.dataset.merchant).sort(),
      );
      const want = ins.unresolved.groups.map((g) => g.merchantKey).sort();
      return [want.length >= 3 && dom.join() === want.join(), `dom=${dom} api=${want}`];
    },
  );
  await t('REQ-SI7-4 the list is headed "Other — to review (N movements, €X)"', async () => {
    const text = norm(await card.innerText());
    const m = text.match(/Other — to review \((\d+) movements?, ([^)]+)\)/);
    return [
      !!m &&
        Number(m[1]) === ins.unresolved.count &&
        amounts(m[2]).includes(ins.unresolved.totalCents),
      m?.[0] ?? text.slice(0, 120),
    ];
  });

  await t(
    'REQ-SI7-5 the select offers every allowed category and none the sign rule forbids',
    async () => {
      const plain = page
        .locator('.movements .movement:not(.internal):not(.pending):not(.verifying)')
        .filter({ hasNotText: 'Between your accounts' });
      const debit = plain.filter({ has: page.locator('.amount:not(.credit)') }).first();
      const credit = plain.filter({ has: page.locator('.amount.credit') }).first();
      const d = await optionsOf(debit);
      const c = await optionsOf(credit);
      const same = (got, banned) =>
        [...got].sort().join() ===
        IDS.filter((i) => i !== banned)
          .sort()
          .join();
      return [same(d, 'income') && same(c, 'transfer_person'), `debit=${d} credit=${c}`];
    },
  );
  await t('A11Y (07 rules) chip controls are native, named and in the tab order', async () => {
    const a = await a11y(page, ['category-select', 'category-ask', 'unresolved-candidate']);
    return [
      a.found['category-select'] > 0 && a.found['category-ask'] > 0 && a.issues.length === 0,
      `${JSON.stringify(a.found)} ${a.issues.join('; ')}`,
    ];
  });
  await t('A11Y (07) category-ask is named "Ask the assistant"', async () => {
    const n = await tid(page.locator('.movements'), 'category-ask')
      .first()
      .evaluate((e) => e.getAttribute('aria-label') || e.textContent || e.title);
    return [/Ask the assistant/.test(n), n];
  });
  await t(
    'REQ-SI7-12 1440 px: card and chips inside the page, no horizontal overflow',
    async () => {
      const o = await overflow(page, 1440);
      return [
        (await card.count()) === 1 && o.scrollWidth <= 1440 && o.out.length === 0,
        `scrollWidth=${o.scrollWidth} ${o.out.join(', ')}`,
      ];
    },
  );
  await page.waitForLoadState('networkidle');
  await t('REQ-SI7-12 no console error or hydration warning with the card and chips', async () => [
    (await card.count()) === 1 && errors.length === 0,
    errors.join(' | '),
  ]);
  await page.screenshot({ path: `${SHOTS}/acceptance-si7-insights-1440.png`, fullPage: true });
  await ctx.close();

  const phone = await open('lucia', { viewport: { width: 390, height: 844 } });
  await viewAll(phone.page);
  await t('REQ-SI7-12 390 px: card and chips shown, no horizontal overflow', async () => {
    const o = await overflow(phone.page, 390);
    return [
      (await tid(phone.page, 'spending-card').count()) === 1 &&
        (await tid(phone.page, 'category-chip').count()) > 0 &&
        o.scrollWidth <= 390 &&
        o.out.length === 0,
      `scrollWidth=${o.scrollWidth} ${o.out.join(', ')}`,
    ];
  });
  await t('REQ-SI7-12 390 px: no console error or hydration warning', async () => [
    (await tid(phone.page, 'spending-card').count()) === 1 && phone.errors.length === 0,
    phone.errors.join(' | '),
  ]);
  await phone.page.screenshot({ path: `${SHOTS}/acceptance-si7-insights-390.png`, fullPage: true });
  await phone.ctx.close();
});

// ================= Live, changing: Bruno's injected ZZQXV movements =================
await live('live changes (Bruno)', async () => {
  const { ctx, page } = await open('bruno');
  const taken = new Set(
    ((await api(page, '/api/dashboard')).movements ?? []).map((m) => Math.abs(m.amountCents)),
  );
  const letters = () =>
    Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(
      '',
    );
  const cents = () => {
    for (;;) {
      const c = 1000 + Math.floor(Math.random() * 8900);
      if (!taken.has(c) && taken.add(c)) return c;
    }
  };
  const run = letters();
  const inject = async (suffix) => {
    const c = cents();
    const r = await fetch(`${BANK}/_control/movement`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alt-control': CONTROL },
      body: JSON.stringify({
        accountId: 'acc-bruno',
        amountCents: -c,
        description: `ZZQXV ${run}${suffix}`,
      }),
    });
    if (!r.ok) throw new Error(`inject ${r.status}`);
    return c;
  };
  // Merchant A: three movements (offer → yes → notice → Undo). B: two (offer → no). C: two (rule
  // listed, then removed from the list).
  const [a1, a2, a3] = [await inject('A'), await inject('A'), await inject('A')];
  const [b1, b2] = [await inject('B'), await inject('B')];
  const [c1, c2] = [await inject('C'), await inject('C')];
  await toOverview(page);
  const dash = await api(page, '/api/dashboard');
  const mov = (c) => dash.movements.find((m) => m.amountCents === -c);
  const key = (c) => mov(c)?.category?.merchantKey ?? `ZZQXV ${run}?`;
  const state = (c) => chipOf(rowOf(page, c));
  const is = async (c, category, st) => {
    const s = await state(c);
    return s.category === category && s.state === st;
  };
  const sets = postsTo(page, '/api/insights/categories');
  const deletes = postsTo(page, '/api/insights/rules/', 'DELETE');

  await t('HARNESS the injected ZZQXV movements are rows of Overview', async () => [
    !!mov(a1) && (await rowOf(page, a1).count()) === 1 && (await rowOf(page, c2).count()) === 1,
    `ids ${[a1, b1, c1].map((c) => mov(c)?.id)}`,
  ]);
  await t(
    'REQ-SI7-4 an injected ZZQXV movement is "Other · to review" and has its unresolved-group',
    async () => {
      const s = await state(a1);
      const group = page.locator(`[data-testid="unresolved-group"][data-merchant="${key(a1)}"]`);
      return [
        s.state === 'needs_review' && (await group.count()) === 1,
        `${JSON.stringify(s)} key=${key(a1)}`,
      ];
    },
  );
  await t('REQ-SI7-4 Bruno: the ESPAI NOU group counts its four movements', async () => {
    const g = dash.insights.unresolved.groups.find((x) => x.merchantKey === 'ESPAI NOU');
    const text = norm(
      await page.locator('[data-testid="unresolved-group"][data-merchant="ESPAI NOU"]').innerText(),
    );
    return [g?.count === 4 && /\b4\b/.test(text) && amounts(text).includes(g.totalCents), text];
  });

  // ---- A: change one, accept the offer with the keyboard, undo ----
  await t(
    "REQ-SI7-5 choosing a category posts that row's movementIds and the category",
    async () => {
      const body = await pick(page, rowOf(page, a1), 'health');
      return [
        JSON.stringify(body.movementIds) === JSON.stringify(mov(a1).category.movementIds) &&
          body.category === 'health' &&
          body.applyToSimilar !== true,
        JSON.stringify(body),
      ];
    },
  );
  await t('REQ-SI7-5 the chip then shows the category as confirmed', async () => [
    await until(() => is(a1, 'health', 'confirmed')),
    JSON.stringify(await state(a1)),
  ]);
  await t('REQ-SI7-10 why: a movement set by hand says "Set by you"', async () => {
    const why = await whyOf(rowOf(page, a1));
    return [why.includes('Set by you'), why];
  });
  const yes = tid(page, 'similar-offer-yes');
  await t('REQ-SI7-6 after a change with similar movements the offer appears once', async () => {
    await yes.first().waitFor();
    const line =
      (await page.getByRole('status').allInnerTexts()).map(norm).find((s) => /Apply /.test(s)) ??
      '';
    return [
      (await yes.count()) === 1 &&
        (await tid(page, 'similar-offer-no').count()) === 1 &&
        line.includes(`Apply Health to the 2 other ${key(a1)} movements and to future ones?`),
      line,
    ];
  });
  await t('A11Y (07 rules) the offer buttons are native, named and in the tab order', async () => {
    const a = await a11y(page, ['similar-offer-yes', 'similar-offer-no']);
    return [a.found['similar-offer-yes'] === 1 && a.issues.length === 0, a.issues.join('; ')];
  });
  await t(
    'REQ-SI7-6 similar-offer-yes (pressed with Enter) posts applyToSimilar: true',
    async () => {
      const n = sets.length;
      await yes.focus();
      await page.keyboard.press('Enter');
      await until(() => sets.length > n);
      const body = sets.at(-1).body;
      return [
        sets.length === n + 1 && body.applyToSimilar === true && body.category === 'health',
        JSON.stringify(body),
      ];
    },
  );
  const notice = tid(page, 'insights-notice');
  await t(
    'REQ-SI7-6 insights-notice (role="status") names the merchant and the category',
    async () => {
      await notice.waitFor();
      const text = norm(await notice.innerText());
      return [
        text.includes(key(a1)) &&
          text.includes('Health') &&
          (await notice.getAttribute('role')) === 'status',
        text,
      ];
    },
  );
  await t(
    'REQ-SI7-6 the offer is gone after the answer and the similar rows are confirmed',
    async () => [
      (await until(
        async () => (await is(a2, 'health', 'confirmed')) && (await is(a3, 'health', 'confirmed')),
      )) && (await yes.count()) === 0,
      `${JSON.stringify(await state(a2))} offers=${await yes.count()}`,
    ],
  );
  await t('REQ-SI7-10 why: a movement set by a rule says "Your rule for <merchant>"', async () => {
    const why = await whyOf(rowOf(page, a2));
    return [why.includes(`Your rule for ${key(a1)}`), why];
  });
  await t('REQ-SI7-7 rule-item lists each rule the server returns', async () => {
    const { rules } = await api(page, '/api/insights/rules');
    const dom = await tid(page, 'rule-item').evaluateAll((els) =>
      els.map((e) => e.dataset.merchant).sort(),
    );
    const text = norm(
      await page.locator(`[data-testid="rule-item"][data-merchant="${key(a1)}"]`).innerText(),
    );
    return [
      dom.join() ===
        rules
          .map((r) => r.merchantKey)
          .sort()
          .join() &&
        text.includes(key(a1)) &&
        text.includes('Health'),
      `${dom} | ${text}`,
    ];
  });
  await t(
    'A11Y (07 rules) Undo and the rule remove button are native, named and in the tab order',
    async () => {
      const a = await a11y(page, ['insights-undo', 'rule-remove']);
      return [
        a.found['insights-undo'] === 1 && a.found['rule-remove'] > 0 && a.issues.length === 0,
        a.issues.join('; '),
      ];
    },
  );
  await t('REQ-SI7-7 insights-undo (pressed with Enter) calls DELETE on the rule', async () => {
    const n = deletes.length;
    await tid(page, 'insights-undo').focus();
    await page.keyboard.press('Enter');
    await until(() => deletes.length > n);
    const path = deletes.at(-1)?.path ?? '';
    return [path.endsWith(`/api/insights/rules/${encodeURIComponent(key(a1))}`), path];
  });
  await t(
    'REQ-SI7-7 after Undo the rule is not listed, its movements are back in review, the hand-set one stays',
    async () => [
      (await until(
        async () =>
          (await is(a2, 'other', 'needs_review')) &&
          (await is(a3, 'other', 'needs_review')) &&
          (await page.locator(`[data-testid="rule-item"][data-merchant="${key(a1)}"]`).count()) ===
            0,
      )) && (await is(a1, 'health', 'confirmed')),
      `${JSON.stringify([await state(a1), await state(a2), await state(a3)])}`,
    ],
  );

  // ---- B: change one, decline the offer, reload ----
  await t(
    'REQ-SI7-6 similar-offer-no posts nothing more and leaves the other movement in review',
    async () => {
      await pick(page, rowOf(page, b1), 'transport');
      await tid(page, 'similar-offer-no').waitFor();
      const n = sets.length;
      await tid(page, 'similar-offer-no').click();
      await pause(1500);
      return [
        sets.length === n && (await yes.count()) === 0 && (await is(b2, 'other', 'needs_review')),
        `posts ${n} → ${sets.length}, b2 ${JSON.stringify(await state(b2))}`,
      ];
    },
  );
  await t(
    'REQ-SI7-5 the confirmed category survives a reload; the offer does not come back',
    async () => {
      await toOverview(page);
      await rowOf(page, b1).waitFor();
      return [
        (await until(() => is(b1, 'transport', 'confirmed'))) && (await yes.count()) === 0,
        JSON.stringify(await state(b1)),
      ];
    },
  );
  await t(
    'REQ-SI7-5 (bank unavailable) a refused change does not show the chip as confirmed',
    async () => {
      await page.route('**/api/insights/categories', (route) =>
        json(route, 503, { error: 'The bank is not available right now.' }),
      );
      await pick(page, rowOf(page, b2), 'health');
      await pause(1500);
      const s = await state(b2);
      await page.unroute('**/api/insights/categories');
      return [s.state !== 'confirmed', JSON.stringify(s)];
    },
  );

  // ---- C: create a rule, remove it from "Your rules" ----
  await t(
    'REQ-SI7-7 rule-remove calls DELETE; the rule leaves the list and its movement returns to review',
    async () => {
      await pick(page, rowOf(page, c1), 'shopping');
      await yes.click();
      const item = page.locator(`[data-testid="rule-item"][data-merchant="${key(c1)}"]`);
      await item.waitFor();
      await until(() => is(c2, 'shopping', 'confirmed'));
      const n = deletes.length;
      await tid(item, 'rule-remove').click();
      await until(() => deletes.length > n);
      const gone = await until(
        async () => (await item.count()) === 0 && (await is(c2, 'other', 'needs_review')),
      );
      return [
        gone && deletes.at(-1).path.endsWith(`/api/insights/rules/${encodeURIComponent(key(c1))}`),
        `${deletes.at(-1)?.path} c2 ${JSON.stringify(await state(c2))}`,
      ];
    },
  );

  // ---- "Ask the assistant": the chat POST is answered here, never by the model ----
  const posts = [];
  const reply = { status: 200, body: {}, hold: null };
  await page.route('**/api/conversations/*/messages', async (route) => {
    posts.push(route.request().postDataJSON());
    if (reply.hold) await reply.hold;
    return json(route, reply.status, reply.body);
  });
  const attached = tid(tid(page, 'composer-extra'), 'attached-movement');
  const ask = async (c, press = false) => {
    await toOverview(page);
    const button = tid(rowOf(page, c), 'category-ask');
    if (!press) return button.click();
    await button.focus();
    await page.keyboard.press('Enter');
  };
  let release;
  reply.hold = new Promise((r) => (release = r));
  await t(
    'REQ-SI7-8 category-ask (pressed with Enter) opens the Assistant with the movement in the composer',
    async () => {
      await ask(a2, true);
      await attached.waitFor();
      return [
        /Assistant/.test(await active(page)) &&
          (await attached.getAttribute('data-movement-id')) === mov(a2).id,
        `${await active(page)} ${await attached.getAttribute('data-movement-id')}`,
      ];
    },
  );
  await t('REQ-SI7-8 the message POST carries that movementId', async () => {
    await until(() => posts.length > 0);
    return [posts.at(-1)?.movementId === mov(a2).id, JSON.stringify(posts.at(-1))];
  });
  await t(
    'REQ-SI7-8 (07) a movement to review is sent with "Help me categorise this movement."',
    () => [posts.at(-1)?.content === 'Help me categorise this movement.', posts.at(-1)?.content],
  );
  release();
  reply.hold = null;
  await t('REQ-SI7-8 (07) the attachment leaves the composer after a successful post', async () => [
    posts.length > 0 && (await until(async () => (await attached.count()) === 0)),
    `posts=${posts.length}`,
  ]);
  await t('REQ-SI7-8 (07) another movement is sent with "Why is this <label>?"', async () => {
    const n = posts.length;
    await ask(a1);
    await until(() => posts.length > n);
    return [
      posts.at(-1)?.content === 'Why is this Health?' && posts.at(-1)?.movementId === mov(a1).id,
      JSON.stringify(posts.at(-1)),
    ];
  });
  reply.status = 500;
  reply.body = { error: 'Assistant unavailable' };
  await t(
    'REQ-SI7-8 the attached movement can be removed; the next message carries no movementId',
    async () => {
      await ask(a3);
      await page.locator('.message.user.failed').waitFor();
      await attached.waitFor();
      const remove = attached.getByRole('button');
      const named = norm((await remove.getAttribute('aria-label')) || (await remove.innerText()));
      await remove.click();
      await attached.waitFor({ state: 'detached' });
      const n = posts.length;
      await page.getByLabel('Message the assistant').fill('A plain question');
      await page.getByLabel('Message the assistant').press('Enter');
      await until(() => posts.length > n);
      const body = posts.at(-1);
      return [
        named.length > 0 && body.content === 'A plain question' && body.movementId == null,
        `remove="${named}" ${JSON.stringify(body)}`,
      ];
    },
  );
  reply.status = 404;
  reply.body = { error: 'Movement not found.' };
  // Reconciliation (reviewer): 07 said a 404 clears the attachment; the reviewed decision
  // (contracts.md §8, 2.14) is that a refused attach keeps it, so Retry sends it again.
  await t(
    'REQ-SI7-8 a 404 for a stale movement shows the error and keeps the attachment for Retry',
    async () => {
      const n = posts.length;
      await ask(a3);
      await until(() => posts.length > n);
      await page.getByText('Movement not found.').first().waitFor();
      await page.locator('.message.user.failed').waitFor();
      await page.locator('.thinking').waitFor({ state: 'detached' });
      await pause(500);
      const kept = (await attached.getAttribute('data-movement-id')) === mov(a3).id;
      await page.getByRole('button', { name: 'Retry' }).click();
      await until(() => posts.length > n + 1);
      return [
        kept && posts.at(-1)?.movementId === mov(a3).id,
        `kept=${kept} retry=${JSON.stringify(posts.at(-1))}`,
      ];
    },
  );
  await ctx.close();
});

// ================= Stubbed dashboard (contracts.md §7: states the server cannot produce) =================
await scenario('stubbed groups', async () => {
  const state = newState();
  const { ctx, page } = await open('lucia', { routes: stubbed('groups', state) });
  await viewAll(page);
  const group = page.locator(`[data-testid="unresolved-group"][data-merchant="${STUB_KEY}"]`);
  const want = () => state.insights.unresolved.groups[0];
  await t(
    'REQ-SI7-4 a group with candidates shows one unresolved-candidate per candidate, with its probability',
    async () => {
      await group.waitFor();
      const got = await tid(group, 'unresolved-candidate').evaluateAll((els) =>
        els.map((e) => `${e.dataset.category}:${e.textContent.replace(/\s+/g, ' ').trim()}`),
      );
      return [
        (await tid(page, 'unresolved-group').count()) === 1 &&
          got.length === 2 &&
          /^shopping:.*Shopping.*48%/.test(got[0]) &&
          /^health:.*Health.*30%/.test(got[1]),
        got.join(' | '),
      ];
    },
  );
  await t('REQ-SI7-3 (stubbed) the card shows the amounts of dashboard.insights', async () => {
    const bad = [];
    for (const c of state.insights.categories) {
      const text = await page
        .locator(`[data-testid="spending-category"][data-category="${c.id}"]`)
        .innerText();
      if (!amounts(text).includes(c.spentCents))
        bad.push(`${c.id}: ${norm(text)} ≠ ${c.spentCents}`);
    }
    return [state.insights.categories.length > 0 && bad.length === 0, bad.join(' | ')];
  });
  await t(
    'REQ-SI7-10 why: a model decision below the bar shows its confidence, the bar and the candidates',
    async () => {
      const row = page
        .locator('.movements .movement', {
          has: page.locator('[data-testid="category-chip"][data-state="needs_review"]'),
        })
        .first();
      const why = await whyOf(row);
      return [why.includes('48%') && why.includes('80%') && why.includes('Shopping 48%'), why];
    },
  );
  await t(
    'REQ-SI7-7 rule-item lists each rule the server returns ("ESPAI NOU → Eating out & leisure")',
    async () => {
      // Reconciliation (reviewer): the visible text, as for the chips above (`.sr-only` left
      // out, the two parts may be separate elements); the check read `textContent` as one string.
      const items = await tid(page, 'rule-item').evaluateAll((els) =>
        els.map((e) => {
          const c = e.cloneNode(true);
          c.querySelectorAll('.sr-only').forEach((x) => x.remove());
          return `${e.dataset.merchant}|${c.textContent.replace(/\s+/g, ' ').trim()}`;
        }),
      );
      return [
        items.length === 2 &&
          items[0].startsWith('ESPAI NOU|') &&
          /ESPAI NOU ?→ ?Eating out & leisure/.test(items[0]) &&
          (await tid(page, 'rule-remove').count()) === 2,
        items.join(' ; '),
      ];
    },
  );
  await t(
    "REQ-SI7-4 a candidate click posts the group's movementIds and that category",
    async () => {
      await group.locator('[data-testid="unresolved-candidate"][data-category="shopping"]').click();
      await until(() => state.sets.length > 0);
      const body = state.sets[0];
      return [
        [...body.movementIds].sort().join() === [...want().movementIds].sort().join() &&
          body.category === 'shopping',
        JSON.stringify(body),
      ];
    },
  );
  await t(
    'REQ-SI7-6 (stubbed) the offer appears once and Yes posts applyToSimilar: true',
    async () => {
      const yes = tid(page, 'similar-offer-yes');
      await yes.first().waitFor();
      const once = (await yes.count()) === 1;
      await yes.click();
      await until(() => state.sets.length > 1);
      return [
        once &&
          state.sets.length === 2 &&
          state.sets[1].applyToSimilar === true &&
          state.sets[1].category === 'shopping',
        JSON.stringify(state.sets[1]),
      ];
    },
  );
  await t('REQ-SI7-6 (stubbed) insights-notice names the merchant and the category', async () => {
    const text = norm(await tid(page, 'insights-notice').innerText());
    return [text.includes(STUB_KEY) && text.includes('Shopping'), text];
  });
  await t(
    'REQ-SI7-7 (stubbed) insights-undo calls DELETE /api/insights/rules/<merchant key>',
    async () => {
      await tid(page, 'insights-undo').click();
      await until(() => state.calls.length > 0);
      const call = state.calls[0];
      return [
        call?.method === 'DELETE' &&
          call.path.endsWith(`/api/insights/rules/${encodeURIComponent(STUB_KEY)}`),
        JSON.stringify(call),
      ];
    },
  );
  await ctx.close();
});

await scenario('stubbed states', async () => {
  let state = newState();
  let s = await open('lucia', { routes: stubbed('none', state) });
  await t('REQ-SI7-4 with nothing to review no unresolved-group is shown', async () => {
    await tid(s.page, 'spending-card').waitFor();
    return [(await tid(s.page, 'unresolved-group').count()) === 0];
  });
  await s.ctx.close();

  state = newState();
  s = await open('lucia', { routes: stubbed('model', state) });
  await viewAll(s.page);
  await t('REQ-SI7-10 why: a model decision shows its confidence and the bar', async () => {
    const row = s.page
      .locator('.movements .movement', {
        has: s.page.locator('[data-testid="category-chip"][data-category="health"]'),
      })
      .first();
    const c = await chipOf(row);
    const why = await whyOf(row);
    return [c.state === 'estimated' && why.includes('91%') && why.includes('80%'), why];
  });
  await s.ctx.close();

  state = newState();
  s = await open('lucia', { routes: stubbed('pending', state) });
  await viewAll(s.page);
  await pause(1000);
  const before = state.dashboards;
  let after = null;
  setTimeout(() => (after = state.dashboards), 5000);
  await t(
    'REQ-SI7-2 a movement being classified reads "Classifying…" (data-state="pending")',
    async () => {
      const r = (await rows(s.page)).filter((x) => x.state === 'pending');
      return [
        r.length === 2 && r.every((x) => x.text === 'Classifying…'),
        r.map((x) => x.text).join(' | '),
      ];
    },
  );
  await t('REQ-SI7-11 (07) the card says "Classifying 2 movements…"', async () => {
    const text = norm(await tid(s.page, 'spending-card').innerText());
    return [text.includes('Classifying 2 movements…'), text.slice(0, 200)];
  });
  await until(() => after !== null, 6000);
  await t(
    'REQ-SI7-11 while movements are being classified the dashboard is read again within 5 s',
    () => [after > before, `requests ${before} → ${after} in 5 s`],
  );
  await s.ctx.close();

  state = newState();
  s = await open('lucia', { routes: stubbed('unavailable', state) });
  await viewAll(s.page);
  await t('REQ-SI7-10 why: "The classifier did not answer" when the decider failed', async () => {
    const row = s.page
      .locator('.movements .movement', {
        has: s.page.locator('[data-testid="category-chip"][data-state="needs_review"]'),
      })
      .first();
    const why = await whyOf(row);
    return [why.includes('The classifier did not answer'), why];
  });
  await t(
    'REQ-SI7-10 (07) the card says the classifier did not answer; "Try again" posts the reclassify route',
    async () => {
      const card = tid(s.page, 'spending-card');
      const text = norm(await card.innerText());
      await card.getByRole('button', { name: 'Try again' }).click();
      await until(() => state.calls.length > 0);
      return [
        text.includes('The classifier did not answer for 1 movement') &&
          state.calls[0]?.path.endsWith('/api/insights/reclassify'),
        `${JSON.stringify(state.calls[0])} ${text.slice(0, 160)}`,
      ];
    },
  );
  await s.ctx.close();

  state = newState();
  s = await open('lucia', { routes: stubbed('empty', state) });
  await t(
    'REQ-SI7-3 with no spending the card says so and the window note is still present',
    async () => {
      const card = tid(s.page, 'spending-card');
      await card.waitFor();
      return [
        (await tid(card, 'spending-category').count()) === 0 &&
          norm(await card.innerText()).includes('No spending in these movements.') &&
          (await tid(s.page, 'spending-window-note').count()) === 1,
      ];
    },
  );
  await s.ctx.close();
});

// ================= Stubbed chat: attachment, quick replies, cited movements =================
await scenario('stubbed chat', async () => {
  const id = 'conv-lucia-support';
  const msg = (mid, role, content, extras = null) => ({
    id: mid,
    role,
    content,
    created_at: '2026-10-02T10:00:00.000Z',
    run_id: null,
    sources: [],
    extras,
  });
  const movement = {
    id: 'demo-lucia-006',
    title: 'LA ESQUINA',
    amountCents: -1400,
    createdAt: '2026-08-10T19:00:00.000Z',
  };
  const cited = [
    { ...movement, category: 'other' },
    {
      id: 'demo-lucia-016',
      title: 'LA ESQUINA',
      amountCents: -2150,
      createdAt: '2026-09-05T19:00:00.000Z',
      category: 'other',
    },
  ];
  const thread = [
    msg('m1', 'user', 'Help me categorise this movement.', { movement }),
    msg('m2', 'assistant', 'Is it one of these?', {
      quickReplies: [{ label: 'Groceries', value: 'It is groceries' }],
    }),
    msg('m3', 'user', 'Not sure'),
    msg('m4', 'assistant', 'These two look alike. Which category fits?', {
      quickReplies: [
        { label: 'Health', value: 'Set it to Health' },
        { label: 'Other', value: 'Other' },
        { label: 'Skip', value: 'Skip' },
      ],
      citedMovements: cited,
    }),
  ];
  const posts = [];
  const { ctx, page } = await open('lucia', {
    tab: 'assistant',
    ready: 'select[aria-label="Conversation"]',
    routes: async (page) => {
      await page.route(`**/api/conversations/${id}`, (route) =>
        json(route, 200, { messages: thread }),
      );
      await page.route('**/api/conversations/*/messages', (route) => {
        posts.push(route.request().postDataJSON());
        thread.push(
          msg('m5', 'user', posts.at(-1).content),
          msg('m6', 'assistant', 'Done: it is Health now.'),
        );
        return json(route, 200, {});
      });
    },
  });
  await t('REQ-SI7-1 (07) the suggestions slot adds "Where did my money go?"', async () => {
    await page.getByRole('button', { name: '+ New conversation' }).click();
    const s = await page.locator('.suggestions button').allInnerTexts();
    return [s.length === 4 && s.includes('Where did my money go?'), s.join(' | ')];
  });
  await page.waitForFunction(
    (id) => !!document.querySelector(`select[aria-label="Conversation"] option[value="${id}"]`),
    id,
  );
  await page.getByLabel('Conversation', { exact: true }).selectOption(id);
  await page.locator('.message.assistant').nth(1).waitFor();
  const replies = tid(page, 'quick-reply');
  await t(
    'REQ-SI7-9 quick replies of the newest assistant message render as quick-reply buttons',
    async () => {
      const last = await tid(page.locator('.message').last(), 'quick-reply').allInnerTexts();
      return [last.map(norm).join() === 'Health,Other,Skip', last.join(' | ')];
    },
  );
  await t('REQ-SI7-9 older messages show no quick replies', async () => [
    (await replies.count()) === 3 &&
      (await page.getByRole('button', { name: 'Groceries' }).count()) === 0,
    `quick-reply=${await replies.count()}`,
  ]);
  await t('REQ-SI7-9 cited movements render as cited-movement with their ids', async () => {
    const got = await tid(page.locator('.message.assistant').last(), 'cited-movement').evaluateAll(
      (els) =>
        els.map((e) => `${e.dataset.movementId}|${e.textContent.replace(/\s+/g, ' ').trim()}`),
    );
    return [
      got.length === 2 &&
        got[0].startsWith('demo-lucia-006|') &&
        got[1].startsWith('demo-lucia-016|') &&
        got.every((x) => x.includes('LA ESQUINA')) &&
        amounts(got[1]).some((a) => Math.abs(a) === 2150),
      got.join(' ; '),
    ];
  });
  await t('REQ-SI7-8 (07) a user message shows the movement attached to it', async () => {
    const a = tid(page.locator('.message.user').first(), 'attached-movement');
    return [
      (await a.count()) === 1 &&
        (await a.getAttribute('data-movement-id')) === movement.id &&
        (await tid(page.locator('.message.user'), 'attached-movement').count()) === 1,
    ];
  });
  await t(
    'A11Y (07 rules) quick replies are native buttons, named and in the tab order',
    async () => {
      const a = await a11y(page, ['quick-reply']);
      return [a.found['quick-reply'] === 3 && a.issues.length === 0, a.issues.join('; ')];
    },
  );
  await t(
    'REQ-SI7-9 a quick reply (pressed with Enter) sends its value as the next message, with no movementId',
    async () => {
      await replies.first().focus();
      await page.keyboard.press('Enter');
      await until(() => posts.length > 0);
      return [
        posts.length === 1 &&
          posts[0].content === 'Set it to Health' &&
          posts[0].movementId == null,
        JSON.stringify(posts),
      ];
    },
  );
  await t('REQ-SI7-9 after the answer the earlier quick replies are gone', async () => [
    await until(
      async () => (await page.locator('.message').count()) >= 6 && (await replies.count()) === 0,
    ),
    `messages=${await page.locator('.message').count()} quick-reply=${await replies.count()}`,
  ]);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  await t(
    'REQ-SI7-12 1440 px: the chat with attachment and cited movements has no horizontal overflow',
    async () => [
      sw <= 1440 && (await tid(page, 'cited-movement').count()) === 2,
      `scrollWidth=${sw}`,
    ],
  );
  await ctx.close();

  thread.length = 4;
  const phone = await open('lucia', {
    tab: 'assistant',
    ready: 'select[aria-label="Conversation"]',
    viewport: { width: 390, height: 844 },
    routes: (page) =>
      page.route(`**/api/conversations/${id}`, (route) => json(route, 200, { messages: thread })),
  });
  await t(
    'REQ-SI7-12 390 px: the chat with quick replies and cited movements has no horizontal overflow',
    async () => {
      await phone.page.waitForFunction(
        (id) => !!document.querySelector(`select[aria-label="Conversation"] option[value="${id}"]`),
        id,
      );
      await phone.page.getByLabel('Conversation', { exact: true }).selectOption(id);
      await phone.page.locator('.message.assistant').nth(1).waitFor();
      await pause(300);
      const w = await phone.page.evaluate(() => document.documentElement.scrollWidth);
      return [w <= 390 && (await tid(phone.page, 'quick-reply').count()) === 3, `scrollWidth=${w}`];
    },
  );
  await phone.ctx.close();
});

await browser.close();
// On the demo bank every check runs: the count is fixed here so a run on another bank can say
// how many it left out, and so a check that silently stops running is noticed.
const DEMO_CHECKS = 85;
if (DEMO && results.length !== DEMO_CHECKS)
  check(
    'HARNESS every check of the suite ran (update DEMO_CHECKS when a check is added)',
    false,
    `${results.length} ran, ${DEMO_CHECKS} expected`,
  );
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (skipped.length)
  console.log(
    `SKIPPED ${DEMO_CHECKS - results.length} of ${DEMO_CHECKS} checks (${skipped.join('; ')}): this bank is not the demo bank. ` +
      'Not an acceptance pass of REQ-SI7: `npm run e2e:demo` runs them all.',
  );
process.exit(failed ? 1 : 0);
