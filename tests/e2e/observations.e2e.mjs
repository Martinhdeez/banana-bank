// OB2 (REQ-OB-10, REQ-OB-11): the one browser check of round 10 — the "Worth a look" card of
// Overview. Independent of the real date: it uses only `prepared_uncovered`, which the customer
// causes by preparing a transfer above the balance of its source account (`category_up` depends
// on today's date; tests/ob1-observations.test.ts covers it with a date passed in).
// Like prepared-transfers.e2e.mjs it does not use the app the runner points at: it starts its own
// `npm run demo -- --production` on its own ports and a fresh data directory. No model is needed
// and none is started: the run never opens the chat, the decider is off, and the app is given a
// made-up key and an address on this machine where nothing listens, so no call can reach a
// provider.
//
// Run (after `npm run build`; no app has to be running):
//   node tests/e2e/observations.e2e.mjs
//   OB_E2E_APP_PORT (3950; the bank takes it + 1000); PLAYWRIGHT_* and SHOTS as in the other suites.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SHOTS } from './env.mjs';

const appPort = process.env.OB_E2E_APP_PORT || '3950';
const bankPort = String(Number(appPort) + 1000);
const URL = `http://127.0.0.1:${appPort}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const healthy = () =>
  fetch(`${URL}/api/health`).then(
    (r) => r.ok,
    () => false,
  );
if (await healthy()) {
  console.log(`FAIL env — something already answers on ${URL}; set OB_E2E_APP_PORT`);
  process.exit(1);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bananabank-e2e-ob-'));
const { DECIDER_API_KEY, ...env } = process.env;
const demo = spawn(process.execPath, ['--import', 'tsx', 'scripts/demo.ts', '--production'], {
  stdio: ['ignore', 'ignore', 'inherit'],
  env: {
    ...env,
    OPENAI_API_KEY: 'test-fake',
    OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
    DECIDER: 'none',
    OBSERVATIONS: 'on',
    DEMO_APP_PORT: appPort,
    DEMO_BANK_PORT: bankPort,
    DEMO_DATA_DIR: dataDir,
  },
});
const gone = once(demo, 'exit');
let browser;
async function stop(code) {
  await browser?.close();
  demo.kill('SIGTERM'); // scripts/demo.ts stops its own children
  await gone;
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(code);
}
for (let i = 0; i < 90 && demo.exitCode === null && !(await healthy()); i++)
  await new Promise((r) => setTimeout(r, 1000));
if (!(await healthy())) {
  console.log('FAIL env — the demo app did not start (run `npm run build` first)');
  await stop(1);
}

const money = (cents) =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
try {
  browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.request.post(`${URL}/api/session`, { data: { userId: 'lucia' } });
  await ctx.addInitScript(() => localStorage.setItem('banana_person', 'lucia'));
  const page = await ctx.newPage();
  const go = async (tab) => {
    await page.goto(`${URL}/?tab=${tab}`);
    await page.waitForSelector(tab === 'transfers' ? '.transfer-form' : '.page-heading');
    // The first dashboard of the page is on screen (the spending card comes with it).
    if (tab === 'overview') await page.getByTestId('spending-card').waitFor();
  };
  const dash = async () => (await ctx.request.get(`${URL}/api/dashboard`)).json();
  const shot = (name) =>
    page.screenshot({ path: path.join(SHOTS, `ob2-${name}.png`), fullPage: true });
  const card = page.getByTestId('observation-card');
  const prepared = (concept) => page.getByTestId('prepared-card').filter({ hasText: concept });
  async function fill(amount, concept) {
    await page.locator('.from-tile', { hasText: 'Aurora account' }).click();
    await page.locator('select[aria-label="Recipient"]').selectOption({ index: 1 });
    await page.getByLabel('Amount in euros').fill(amount);
    await page.getByPlaceholder('What is this transfer for?').fill(concept);
  }
  // "Prepare for later" in the transfer form, "When I say" (the default).
  async function prepare(cents, concept) {
    await go('transfers');
    await fill((cents / 100).toFixed(2), concept);
    await page.getByTestId('prepare-later').click();
    await page.getByTestId('prepare-save').click();
    await prepared(concept).waitFor();
  }

  // 0. At the start: nothing prepared, no card. The source is the account the form starts with.
  const start = await dash();
  const aurora = start.accounts.find((a) => a.label === 'Aurora account');
  await go('overview');
  check(
    'start: Lucía has nothing prepared and no card; the slot holds the spending card alone',
    start.observation === null &&
      start.prepared.length === 0 &&
      (await card.count()) === 0 &&
      (await page.getByTestId('overview-insights').locator('> *').count()) === 1,
    `Aurora account ${money(aurora.balanceCents)}`,
  );

  // 1. Prepare a transfer above the balance → the card states it with the amount and the balance.
  const first = aurora.balanceCents + 50000;
  await prepare(first, 'Rent November');
  const firstId = await prepared('Rent November').getAttribute('data-prepared-id');
  await go('overview');
  await card.waitFor();
  const basis = await card.getByTestId('observation-basis').innerText();
  const one = (await dash()).observation;
  check(
    'prepared above the balance: the card says so with the exact amount and balance',
    (await card.getAttribute('data-kind')) === 'prepared_uncovered' &&
      basis.includes(`Your prepared transfer of ${money(first)} to `) &&
      basis.includes(
        `is more than the ${money(aurora.balanceCents)} in your Aurora account today.`,
      ) &&
      basis === one.basis,
    basis,
  );
  const text = await card.innerText();
  check(
    'the card: eyebrow, title, "not advice", and it is above the spending card',
    /^WORTH A LOOK\s+A prepared transfer is not covered/i.test(text) &&
      text.includes('A fact from your movements, not advice.') &&
      (await page
        .getByTestId('overview-insights')
        .locator('> *')
        .evaluateAll((els) => els.map((e) => e.dataset.testid).join(','))) ===
        'observation-card,spending-card',
  );
  check(
    'no focus is taken on load',
    await page.evaluate(() => !document.activeElement?.closest('[data-testid="observation-card"]')),
  );
  await shot('1-card');

  // 2. 390 × 844 (REQ-OB-10): nothing scrolls sideways; the buttons are 44 px touch targets.
  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="observation-card"]');
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      card: c.scrollWidth - c.clientWidth,
      heights: [...c.querySelectorAll('button')].map((b) => b.getBoundingClientRect().height),
    };
  });
  check(
    '390 px: no sideways scroll, three buttons of at least 44 px',
    narrow.page <= 0 &&
      narrow.card <= 0 &&
      narrow.heights.length === 3 &&
      narrow.heights.every((h) => h >= 44),
    JSON.stringify(narrow),
  );
  await shot('2-card-390');
  await page.setViewportSize({ width: 1280, height: 900 });

  // 3. Keyboard: the three buttons in order; Enter on the first lands on that prepared transfer.
  await card.getByTestId('observation-action').focus();
  const order = ['observation-action'];
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => document.activeElement?.dataset.testid));
  }
  await card.getByTestId('observation-action').focus();
  await page.keyboard.press('Enter');
  await prepared('Rent November').waitFor();
  await page.waitForFunction((id) => document.activeElement?.id === `prepared-${id}`, firstId, {
    timeout: 5000,
  });
  check(
    'keyboard: action, Dismiss, "Don’t show these" in order; "See prepared transfer" lands on Transfers with the focus on that card',
    order.join(',') === 'observation-action,observation-dismiss,observation-off' &&
      page.url().endsWith('?tab=transfers') &&
      one.preparedId === firstId,
    order.join(' → '),
  );
  await shot('3-transfers-card');

  // 4. Back, Dismiss → gone at once, and still gone after a reload.
  await go('overview');
  await card.waitFor();
  const dismissed = page.waitForResponse((r) => r.url().endsWith('/api/observations'));
  await card.getByTestId('observation-dismiss').click();
  check('dismiss: the card is gone at once', (await card.count()) === 0);
  check('dismiss: POST /api/observations answered ok', (await dismissed).status() === 200);
  await go('overview');
  check(
    'dismiss: still gone after a reload; the prepared transfer itself is untouched',
    (await card.count()) === 0 &&
      (await dash()).observation === null &&
      (await dash()).prepared.length === 1,
  );

  // 5. A second such transfer → a new card, with another key.
  const second = aurora.balanceCents + 120000;
  await prepare(second, 'Car deposit');
  await go('overview');
  await card.waitFor();
  const two = (await dash()).observation;
  check(
    'a second prepared transfer above the balance: a new card (another key) with its amount',
    two.key !== one.key &&
      (await card.getByTestId('observation-basis').innerText()).includes(
        `Your prepared transfer of ${money(second)} to `,
      ),
    two.key.replace(/:[0-9a-f-]{36}:/, ':<id>:'),
  );

  // 6. Never while a transfer waits for the customer's confirmation; back once it is cancelled.
  await go('transfers');
  await fill('5.00', 'Coffee');
  await page.getByRole('button', { name: 'Review transfer' }).click();
  await page.locator('.approvals .proposal').first().waitFor();
  await go('overview');
  check(
    'a transfer awaiting confirmation: no card',
    (await card.count()) === 0 &&
      (await dash()).approvals.length === 1 &&
      (await dash()).observation === null,
  );
  await go('transfers');
  await page.locator('.approvals .proposal').getByRole('button', { name: 'Cancel' }).click();
  await page.locator('.approvals .proposal').waitFor({ state: 'detached' });
  await go('overview');
  await card.waitFor();
  check('the proposal cancelled: the card is back', (await dash()).observation.key === two.key);

  // 7. "Don't show these" → the status line; Undo brings the card back; off again → nothing,
  // also after a reload.
  const status = page.getByTestId('observation-off-status');
  await card.getByTestId('observation-off').click();
  await status.waitFor();
  check(
    '"Don’t show these": no card, one status line that says how to get them back, focus on Undo',
    (await card.count()) === 0 &&
      (await status.innerText()) ===
        'Observations are off. You can turn these back on in “What the assistant may do”.' &&
      (await page.evaluate(() => document.activeElement?.dataset.testid)) === 'observation-undo',
  );
  await shot('4-turned-off');
  await page.getByTestId('observation-undo').click();
  await card.waitFor();
  check('Undo: the same card is back', (await dash()).observation.key === two.key);
  const turnedOff = page.waitForResponse((r) => r.url().endsWith('/api/observations'));
  await card.getByTestId('observation-off').click();
  await turnedOff;
  await go('overview');
  check(
    'turned off: no card and no line after a reload; two prepared transfers still there',
    (await card.count()) === 0 &&
      (await status.count()) === 0 &&
      (await dash()).observation === null &&
      (await dash()).prepared.length === 2,
  );
  await ctx.close();
} catch (e) {
  check('observations flow', false, `threw: ${e.message.split('\n')[0]}`);
}
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
await stop(failed ? 1 : 0);
