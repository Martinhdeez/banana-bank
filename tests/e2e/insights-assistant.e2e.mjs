// SI7b: spend insights in the Assistant ("Ask the assistant", "Resolve in chat", the attached
// movement, quick replies, cited movements, the extra suggestion) against a running app.
//
// No model call: the message POST and the conversation read are answered here with the server's
// shapes (contracts.md §3 and §4). The real server is used for everything else, and for what it
// refuses before any model call: an unknown movement (404) and a body with another key (400).
// It works on any bank and writes no category; it leaves empty conversations behind.
//
// Run (app and bank already running):
//   APP_URL=http://127.0.0.1:3000 node tests/e2e/insights-assistant.e2e.mjs
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
const until = async (done) => {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 50));
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fulfil = (route, body, status = 200) => route.fulfill({ status, json: body }).catch(() => {});

// The three reply sets the server builds (src/agent/quick-replies.ts), label and value.
const reply = (label, value = label) => ({ label, value });
const CHOICES = [
  reply('Eating out & leisure'),
  reply('Shopping'),
  reply('Other', 'Another category'),
  reply('Skip'),
];
const OFFER = [
  reply('Yes, apply to the other 3', 'Yes, apply it to all of them'),
  reply('No, only this one'),
];
const REVIEW = [reply('Review them', 'Review the movements to classify'), reply('Not now')];

// `stub(dashboard)` edits the real dashboard answer before the page gets it.
async function open(persona, { width = 1440, tab = 'overview', stub } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  await ctx.request.post(`${URL}/api/session`, { data: { userId: persona } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  let dashboards = 0;
  page.on('request', (r) => r.url().endsWith('/api/dashboard') && dashboards++);
  if (stub)
    await page.route('**/api/dashboard', async (route) => {
      try {
        const real = await (await route.fetch()).json();
        await route.fulfill({ json: stub(real) ?? real });
      } catch {
        // The context was closed while this read was on its way.
      }
    });
  await page.addInitScript((p) => localStorage.setItem('banana_person', p), persona);
  await page.goto(`${URL}/?tab=${tab}`);
  await page.waitForSelector(persona === 'marta' ? 'main' : '.account-card, .chat-layout');
  await page.waitForLoadState('networkidle');
  const dashboard = async () => (await ctx.request.get(`${URL}/api/dashboard`)).json();
  return { ctx, page, errors, dashboard, dashboards: () => dashboards };
}

// The chat of one page, answered here. `mode`: 'stub' answers the POST with 200 and the next
// read with `thread`; 'stale' sends the POST on to the real server with an unknown movement id.
// `hold()` keeps the next POST unanswered until the returned function is called.
async function chat(page) {
  const c = { posts: [], thread: [], mode: 'stub', gate: null, n: 0 };
  c.hold = () => {
    let release;
    c.gate = new Promise((r) => (release = r));
    return () => {
      c.gate = null;
      release();
    };
  };
  c.message = (role, content, extras = null) => ({
    id: `stub-${++c.n}`,
    role,
    content,
    created_at: '2026-10-04T10:00:00.000Z',
    run_id: null,
    sources: [],
    extras,
  });
  await page.route(/\/api\/conversations\/[^/]+\/messages$/, async (route) => {
    const body = route.request().postDataJSON();
    c.posts.push(body);
    if (c.gate) await c.gate;
    if (c.mode === 'stale')
      return route
        .continue({ postData: JSON.stringify({ ...body, movementId: 'no-such-movement' }) })
        .catch(() => {});
    return fulfil(route, { runId: 'run-stub', answer: 'stub', sources: [] });
  });
  await page.route(/\/api\/conversations\/[0-9a-f-]{36}$/, (route) =>
    route.request().method() === 'GET' && c.mode === 'stub'
      ? fulfil(route, { conversation: { id: 'stub', title: 'stub' }, messages: c.thread })
      : route.continue().catch(() => {}),
  );
  return c;
}
const viewAll = async (page) => {
  const all = page.getByRole('button', { name: 'View all' });
  if (await all.count()) await all.click();
};
const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const composerCard = (page) =>
  page.locator('[data-testid="composer-extra"] [data-testid="attached-movement"]');
const replies = (page) => page.getByTestId('quick-reply');
const labels = (page) => replies(page).evaluateAll((els) => els.map((e) => e.innerText));
const textarea = (page) => page.getByLabel('Message the assistant');
// Type and send once the turn before has ended (the send button is disabled until then).
async function type(page, text) {
  await textarea(page).fill(text);
  await page.waitForFunction(
    () => !document.querySelector('button[aria-label="Send message"]').disabled,
  );
  await textarea(page).press('Enter');
}
const focused = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el?.dataset.testid || el?.getAttribute('aria-label') || el?.tagName;
  });
// The whole of a 44 px target answers a tap: the element (or a child) is hit at its centre and
// 20 px from it in the four directions.
const tappable = (locator) =>
  locator.evaluate((el) => {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    return [
      [cx, cy],
      [cx, cy - 20],
      [cx, cy + 20],
      [Math.max(r.x + 2, cx - 20), cy],
      [Math.min(r.right - 2, cx + 20), cy],
    ].every(([x, y]) => el.contains(document.elementFromPoint(x, y)));
  });
// A row with a decided category whose title is unique in the table (so the row and the
// dashboard movement can be matched).
async function decidedRow(page, dash) {
  const rows = page.locator('.movements .movement:has([data-testid="category-ask"])');
  for (let i = 0; i < (await rows.count()); i++) {
    const row = rows.nth(i);
    const chip = row.getByTestId('category-chip');
    const state = await chip.getAttribute('data-state');
    if (state !== 'estimated' && state !== 'confirmed') continue;
    const title = await row.locator('.movement-main strong').first().innerText();
    return { row, title, category: await chip.getAttribute('data-category') };
  }
  throw new Error(`no decided row among ${dash.movements.length} movements`);
}

const dash = await (await open('bruno')).dashboard();
const demo = dash.movements.some((m) => m.id.startsWith('demo-'));
console.log(`Bank: ${demo ? 'demo bank' : 'not the demo bank'}`);
const ids = new Set(dash.movements.map((m) => m.id));

// The whole chat flow at three widths, with a screenshot of each state.
for (const width of [1440, 1280, 390])
  await run(`Flow at ${width}`, async () => {
    const shot = (name) => page.screenshot({ path: `${SHOTS}/si7b-${name}-${width}.png` });
    const { ctx, page, errors, dashboards } = await open('bruno', { width });
    const c = await chat(page);
    await page.getByTestId('spending-card').waitFor();
    await viewAll(page);
    const { row, title, category } = await decidedRow(page, dash);
    const ask = row.getByTestId('category-ask');
    await ask.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await shot('chip-ask');
    if (width === 390) {
      const box = await ask.boundingBox();
      check(
        '390 px: "Ask the assistant" is a touch target of 44 px, all of it answers',
        box.height >= 44 && box.width >= 44 && (await tappable(ask)),
        `${Math.round(box.width)} × ${Math.round(box.height)}`,
      );
    }

    // 1. Ask from the chip: a new conversation, the movement attached, the question sent.
    let release = c.hold();
    await ask.click();
    await composerCard(page).waitFor();
    await page.locator('.thinking').waitFor();
    await until(() => c.posts.length);
    const post = c.posts[0];
    const movementId = await composerCard(page).getAttribute('data-movement-id');
    const movement = dash.movements.find((m) => m.id === post.movementId);
    check(
      `REQ-SI7-8 ${width}: "Ask the assistant" opens the Assistant with the movement in the composer`,
      page.url().endsWith('?tab=assistant') &&
        (await composerCard(page).innerText()).includes(title) &&
        (await composerCard(page).getByRole('button').getAttribute('aria-label')) ===
          'Remove the attached movement',
      (await composerCard(page).innerText()).replace(/\s+/g, ' '),
    );
    check(
      `REQ-SI7-8 ${width}: the POST is exactly {content, movementId} for that row's movement`,
      same(Object.keys(post), ['content', 'movementId']) &&
        post.content === `Why is this ${LABELS[category]}?` &&
        post.movementId === movementId &&
        movement?.category.id === category,
      JSON.stringify(post),
    );
    const pending = page.locator('.message.user [data-testid="attached-movement"]');
    check(
      `${width}: the message in flight already shows its attachment; focus is in the composer`,
      (await pending.count()) === 1 &&
        (await pending.getByRole('button').count()) === 0 &&
        (await focused(page)) === 'Message the assistant',
      await focused(page),
    );
    await shot('attached-sending');
    const xss = '<img src=x onerror="window.__si7b=1">';
    const attachment = { id: movementId, title, amountCents: -1850, createdAt: movement.createdAt };
    c.thread = [
      c.message('user', post.content, { movement: attachment }),
      c.message('assistant', 'Two movements look like this one. Which category fits?', {
        citedMovements: [
          { ...attachment, category: 'eating_out_leisure' },
          { ...attachment, id: 'cited-2', title: `ESPAI NOU ${xss}`, category: 'shopping' },
        ],
        quickReplies: CHOICES,
      }),
    ];
    const before = dashboards();
    release();
    await replies(page).first().waitFor();
    await until(() => dashboards() > before);
    const citedText = await page.getByTestId('cited-movement').allInnerTexts();
    check(
      `${width}: after the turn the composer is empty and the user message keeps its card`,
      (await page.getByTestId('composer-extra').count()) === 0 &&
        (await page.locator('.message.user [data-testid="attached-movement"]').count()) === 1 &&
        (await page
          .locator('.message.user [data-testid="attached-movement"]')
          .getAttribute('data-movement-id')) === movementId,
    );
    check(
      `REQ-SI7-9 ${width}: cited movements render under the answer, bank text as text`,
      citedText.length === 2 &&
        citedText[0].includes(title) &&
        citedText[0].includes('Eating out & leisure') &&
        citedText[0].includes(money(-1850)) &&
        citedText[1].includes(xss) &&
        (await page.locator('.thread img').count()) === 0 &&
        (await page.evaluate(() => window.__si7b)) === undefined &&
        (await page.getByTestId('cited-movement').nth(1).getAttribute('data-movement-id')) ===
          'cited-2',
      citedText.join(' | ').replace(/\s+/g, ' ').slice(0, 160),
    );
    check(
      `REQ-SI7-9 ${width}: the newest answer's replies are buttons with their labels`,
      same(
        await labels(page),
        CHOICES.map((r) => r.label),
      ) &&
        (await page.getByRole('group', { name: 'Quick replies' }).count()) === 1 &&
        (await replies(page).evaluateAll((els) => els.every((e) => e.type === 'button'))),
      (await labels(page)).join(' · '),
    );
    check(
      `${width}: the Overview data is read again after the turn`,
      dashboards() > before,
      `${dashboards() - before} dashboard reads`,
    );
    await shot('cited-choices');
    if (width === 390) {
      const boxes = await replies(page).evaluateAll((els) =>
        els.map((e) => e.getBoundingClientRect()).map((r) => [r.width, r.height]),
      );
      check(
        '390 px: every quick reply is at least 44 × 44 px',
        boxes.every(([w, h]) => w >= 44 && h >= 44),
        boxes.map(([w, h]) => `${Math.round(w)}×${Math.round(h)}`).join(' '),
      );
    }

    // 2. A click sends the value (not the label), without a movement id; the buttons stay in
    // place, disabled, while the turn runs.
    const place = await replies(page).first().boundingBox();
    release = c.hold();
    await replies(page).nth(2).click();
    await page.locator('.thinking').waitFor();
    const during = await replies(page).first().boundingBox();
    await replies(page)
      .nth(1)
      .click({ force: true, timeout: 1000 })
      .catch(() => {});
    check(
      `REQ-SI7-9 ${width}: a click sends its value as the next message, and nothing else`,
      same(c.posts[1], { content: 'Another category' }) && c.posts.length === 2,
      JSON.stringify(c.posts.slice(1)),
    );
    check(
      `${width}: while the turn runs the replies are disabled and do not move`,
      (await replies(page).count()) === 4 &&
        (await replies(page).evaluateAll((els) => els.every((e) => e.disabled))) &&
        Math.abs(during.y - place.y) < 1 &&
        during.x === place.x,
    );
    await page.locator('.thinking').evaluate((el) => el.scrollIntoView({ block: 'end' }));
    await shot('replies-disabled');
    c.thread = [
      ...c.thread,
      c.message('user', 'Another category'),
      c.message('assistant', 'Done: it is Eating out & leisure now. Three more are like it.', {
        quickReplies: OFFER,
      }),
    ];
    release();
    await page.getByRole('button', { name: OFFER[0].label }).waitFor();
    check(
      `REQ-SI7-9 ${width}: only the newest assistant message shows replies`,
      same(
        await labels(page),
        OFFER.map((r) => r.label),
      ) &&
        (await page.locator('.message.assistant').first().getByTestId('quick-reply').count()) ===
          0 &&
        (await page.getByTestId('cited-movement').count()) === 2,
      (await labels(page)).join(' · '),
    );
    await shot('offer');

    // 3. By keyboard: back from the composer to the last reply, visible focus, Enter sends.
    await textarea(page).focus();
    for (let i = 0; i < 8 && (await focused(page)) !== 'quick-reply'; i++)
      await page.keyboard.press('Shift+Tab');
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outline);
    c.thread = [
      ...c.thread,
      c.message('user', 'No, only this one'),
      c.message('assistant', 'You spent €412.30. Four movements still need a category.', {
        quickReplies: REVIEW,
      }),
    ];
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Review them' }).waitFor();
    check(
      `${width}: a reply is reached and sent by keyboard, with a visible focus ring`,
      same(c.posts[2], { content: 'No, only this one' }) && /solid/.test(outline),
      outline,
    );
    // Review of #106: the used reply is replaced, so the keyboard continues in the composer.
    check(
      `${width}: after a reply sent by keyboard the focus is in the composer, not lost`,
      (await focused(page)) === 'Message the assistant',
      await focused(page),
    );
    check(
      `${width}: the result of a click is announced (the thread is a polite live log)`,
      (await page
        .locator('[role="log"][aria-live="polite"]')
        .getByTestId('quick-reply')
        .count()) === 2,
    );
    await shot('review');
    c.thread = [
      ...c.thread,
      c.message('user', REVIEW[0].value),
      c.message('assistant', 'Open Overview to go through them.'),
    ];
    // Review of #106: a draft in the composer is not what the reply sends, and it is kept.
    await textarea(page).fill('a draft');
    await page.getByRole('button', { name: 'Review them' }).click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="quick-reply"]'));
    check(
      `${width}: "Review them" sends its value; an answer without replies shows none`,
      same(c.posts[3], { content: 'Review the movements to classify' }),
      JSON.stringify(c.posts[3]),
    );
    check(
      `${width}: a typed draft survives a reply click`,
      (await textarea(page).inputValue()) === 'a draft',
    );
    await textarea(page).fill('');

    // 4. A refused attachment, by the real server: nothing stored, nothing lost.
    await page.locator('nav[aria-label="Sections"] button', { hasText: 'Overview' }).click();
    await viewAll(page);
    c.mode = 'stale';
    await (await decidedRow(page, dash)).row.getByTestId('category-ask').click();
    const failed = page.locator('.message.user.failed');
    await failed.waitFor();
    const alert = await page.locator('.alert.error').innerText();
    check(
      `${width}: an unknown movement is refused: the chat's error, the text with Retry, the attachment kept`,
      alert.includes('Movement not found.') &&
        (await failed.innerText()).includes(post.content) &&
        (await failed.getByRole('button', { name: 'Retry' }).count()) === 1 &&
        (await composerCard(page).count()) === 1 &&
        (await page.locator('.message.user:not(.failed)').count()) === 0,
      alert.replace(/\s+/g, ' '),
    );
    await shot('attach-refused');
    const sent = c.posts.length;
    await failed.getByRole('button', { name: 'Retry' }).click();
    await until(() => c.posts.length > sent);
    await failed.waitFor();
    check(
      `${width}: Retry sends the text and the attachment again`,
      c.posts.length === sent + 1 && same(c.posts.at(-1), post),
      JSON.stringify(c.posts.at(-1)),
    );
    if (width === 390)
      check(
        '390 px: the remove button answers a tap 20 px around its centre',
        await tappable(composerCard(page).getByRole('button')),
      );
    await composerCard(page).getByRole('button').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="composer-extra"]'));
    await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA');
    c.mode = 'stub';
    c.thread = [c.message('user', 'Just a question'), c.message('assistant', 'Just an answer.')];
    await type(page, 'Just a question');
    await page.locator('.message.assistant .message-body').waitFor();
    check(
      `${width}: after removing the attachment a message goes without a movement id`,
      same(c.posts.at(-1), { content: 'Just a question' }) &&
        (await page.locator('.message-extra').count()) === 0,
      JSON.stringify(c.posts.at(-1)),
    );
    const over = await overflow(page);
    const bad = errors.filter((e) => HYDRATION.test(e) || !/Failed to load resource/.test(e));
    check(
      `REQ-SI7-12 ${width}: no horizontal overflow, no console error or hydration warning`,
      over <= 0 && bad.length === 0,
      `overflow ${over}px${bad.length ? ` · ${bad.join(' | ').slice(0, 200)}` : ''}`,
    );
    await ctx.close();
  });

await run('Resolve in chat', async () => {
  // A review group for one real movement when the bank has none (the default bank with rules).
  const target = dash.insights.unresolved.groups[0]?.movementIds[0] ?? dash.movements[0].id;
  const { ctx, page } = await open('bruno', {
    width: 390,
    stub: (d) => {
      if (d.insights.unresolved.count) return d;
      const m = d.movements.find((x) => x.id === target);
      const group = {
        merchantKey: 'CORNER SHOP',
        title: 'CORNER SHOP',
        count: 1,
        totalCents: Math.abs(m.amountCents),
        movementIds: [m.id],
        candidates: [],
        reason: 'no_decider',
      };
      d.insights.unresolved = { count: 1, totalCents: group.totalCents, groups: [group] };
      return d;
    },
  });
  const c = await chat(page);
  const group = page.getByTestId('unresolved-group').first();
  const resolve = group.getByRole('button', { name: /^Resolve .+ in chat$/ });
  await resolve.waitFor();
  check(
    'every review group has "Resolve in chat"',
    (await page.getByRole('button', { name: /^Resolve .+ in chat$/ }).count()) ===
      (await page.getByTestId('unresolved-group').count()) &&
      (await resolve.innerText()) === 'Resolve in chat',
  );
  check('390 px: "Resolve in chat" answers a tap 20 px around its centre', await tappable(resolve));
  await page.screenshot({ path: `${SHOTS}/si7b-resolve-in-chat-390.png` });
  const state = dash.movements.find((m) => m.id === target).category.state;
  const release = c.hold();
  await resolve.click();
  await composerCard(page).waitFor();
  await until(() => c.posts.length);
  check(
    '"Resolve in chat" attaches the group\'s first movement and asks for help',
    c.posts.length === 1 &&
      c.posts[0].movementId === target &&
      c.posts[0].content ===
        (state === 'needs_review'
          ? 'Help me categorise this movement.'
          : `Why is this ${LABELS[dash.movements.find((m) => m.id === target).category.id]}?`) &&
      (await composerCard(page).getAttribute('data-movement-id')) === target,
    JSON.stringify(c.posts[0]),
  );
  release();
  await ctx.close();
});

await run('Suggestions and waiting', async () => {
  const { ctx, page } = await open('bruno', { tab: 'assistant' });
  const c = await chat(page);
  const suggestions = await page.locator('.suggestions button').allInnerTexts();
  check(
    'the suggestions are "Where did my money go?" (first, as on Overview) plus the three of the customer',
    suggestions.length === 4 && suggestions[0] === 'Where did my money go?',
    suggestions.join(' · '),
  );
  await page.screenshot({ path: `${SHOTS}/si7b-suggestions-1440.png` });
  // A turn is running in this conversation; "Ask the assistant" then only attaches.
  const release = c.hold();
  await page.getByRole('button', { name: 'Where did my money go?' }).click();
  await page.locator('.thinking').waitFor();
  await page.locator('nav[aria-label="Sections"] button', { hasText: 'Overview' }).click();
  await viewAll(page);
  await page.getByTestId('category-ask').first().click();
  await composerCard(page).waitFor();
  const waiting = await composerCard(page).getAttribute('data-movement-id');
  check(
    'while a turn runs elsewhere, "Ask the assistant" attaches and sends nothing',
    same(c.posts, [{ content: 'Where did my money go?' }]) &&
      ids.has(waiting) &&
      (await page.getByRole('button', { name: 'Send message' }).isDisabled()),
    JSON.stringify(c.posts),
  );
  c.thread = [];
  release();
  // The other turn ended: the attachment is still there and goes with the typed message.
  c.thread = [c.message('user', 'What is this?'), c.message('assistant', 'A card payment.')];
  await type(page, 'What is this?');
  await page.locator('.message.assistant .message-body').waitFor();
  check(
    'a typed message carries the attachment, which then leaves the composer',
    same(c.posts.at(-1), { content: 'What is this?', movementId: waiting }) &&
      (await page.getByTestId('composer-extra').count()) === 0,
    JSON.stringify(c.posts.at(-1)),
  );
  await ctx.close();
});

await run('Real server', async () => {
  const { ctx, page } = await open('lucia', { tab: 'assistant' });
  // The messages route refuses these before any model call, and stores nothing.
  const { id } = await (await ctx.request.post(`${URL}/api/conversations`, { data: {} })).json();
  const send = async (data) => {
    const r = await ctx.request.post(`${URL}/api/conversations/${id}/messages`, { data });
    return [r.status(), (await r.json()).error];
  };
  const unknown = await send({ content: 'Why?', movementId: 'no-such-movement' });
  const other = await send({ content: 'Why?', movementId: [...ids][0] });
  const strict = await send({ content: 'Why?', movementId: 'm', title: 'x' });
  const stored = (await (await ctx.request.get(`${URL}/api/conversations/${id}`)).json()).messages;
  check(
    'server: unknown and foreign movement 404, another key 400, nothing stored',
    same(unknown, [404, 'Movement not found.']) &&
      same(other, [404, 'Movement not found.']) &&
      strict[0] === 400 &&
      stored.length === 0,
    JSON.stringify([unknown, other, strict, stored.length]),
  );
  // A stored conversation without extras renders with none of the insights parts.
  const old = await page.evaluate(async () => {
    for (const c of await fetch('/api/conversations').then((r) => r.json())) {
      const d = await fetch(`/api/conversations/${c.id}`).then((r) => r.json());
      if (d.messages.length) return { id: c.id, extras: d.messages.map((m) => m.extras) };
    }
  });
  if (!old) console.log('SKIP a stored conversation without extras — this person has none');
  else {
    await page.getByLabel('Conversation', { exact: true }).selectOption(old.id);
    await page.waitForSelector('.message');
    check(
      'server: every message has `extras` (null here); the thread renders without any extra',
      old.extras.every((e) => e === null) &&
        (await page.locator('.message-extra').count()) === 0 &&
        (await page.getByTestId('composer-extra').count()) === 0,
    );
  }
  await ctx.close();
  const op = await open('marta');
  check(
    'nothing for the operator',
    (await op.page.getByTestId('category-ask').count()) === 0 &&
      (await op.page.getByTestId('attached-movement').count()) === 0 &&
      (await op.page.getByText('Resolve in chat').count()) === 0,
  );
  await op.ctx.close();
});

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
