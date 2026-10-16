// Assistant redesign checks (slice 6): U10 UI parts and finding D. No model calls: chat POSTs
// and conversation reads are stubbed with page.route.
// Run: APP_URL=http://127.0.0.1:3700 node tests/e2e/assistant.e2e.mjs
import { APP_URL as URL, launch, requireSeed } from './env.mjs';
await requireSeed(URL);
const browser = await launch();
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (route, status, body) =>
  route
    .fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    .catch(() => {});
async function scenario(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name, false, `threw: ${e.message.split('\n')[0]}`);
  }
}
async function open(width = 1400, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  await page.goto(`${URL}/?tab=assistant`);
  await page.waitForSelector('select[aria-label="Conversation"]');
  await page.waitForFunction(
    () => document.querySelectorAll('select[aria-label="Conversation"] option').length > 1,
  );
  return { ctx, page };
}
// A conversation that already has messages (other e2e runs leave empty ones at the top).
const firstConversation = (page) =>
  page.evaluate(async () => {
    for (const c of await fetch('/api/conversations').then((r) => r.json())) {
      const d = await fetch(`/api/conversations/${c.id}`).then((r) => r.json());
      if (d.messages.length) return c.id;
    }
  });
const msg = (id, role, content, extra = {}) => ({
  id,
  role,
  content,
  created_at: '2026-09-24T10:00:00.000Z',
  run_id: null,
  sources: [],
  ...extra,
});

await scenario('U10 retry', async () => {
  const { ctx, page } = await open();
  const id = await firstConversation(page);
  await page.getByLabel('Conversation', { exact: true }).selectOption(id);
  await page.waitForSelector('.message');
  const posts = [];
  let status = 500;
  await page.route('**/api/conversations/*/messages', (route) => {
    posts.push(route.request().postDataJSON().content);
    return json(route, status, status === 500 ? { error: 'Assistant unavailable' } : {});
  });
  await page.getByLabel('Message the assistant').fill('Retry me please');
  await page.getByLabel('Message the assistant').press('Enter');
  const failed = page.locator('.message.user.failed');
  await failed.waitFor();
  const text = await failed.innerText();
  check(
    'U10 failed bubble keeps the text',
    text.includes('Retry me please') && text.includes('Not sent.'),
    text,
  );
  check(
    'U10 Retry button shown',
    (await failed.getByRole('button', { name: 'Retry' }).count()) === 1,
  );
  check('U10 error alert still shown', (await page.locator('.alert.error').count()) === 1);
  status = 200;
  await failed.getByRole('button', { name: 'Retry' }).click();
  await page.waitForFunction(() => !document.querySelector('.message.user.failed'));
  await pause(500);
  check(
    'U10 Retry sends the same content once',
    posts.length === 2 && posts[1] === 'Retry me please',
    JSON.stringify(posts),
  );
  await ctx.close();
});

await scenario('U10 busy', async () => {
  const { ctx, page } = await open();
  const id = await firstConversation(page);
  await page.getByLabel('Conversation', { exact: true }).selectOption(id);
  await page.waitForSelector('.message');
  let release;
  const gate = new Promise((r) => (release = r));
  await page.route('**/api/conversations/*/messages', async (route) => {
    await gate;
    return json(route, 200, {});
  });
  await page.getByLabel('Message the assistant').fill('hello');
  await page.getByLabel('Message the assistant').press('Enter');
  await page.waitForSelector('.thinking');
  check('U10 thinking shown in its conversation', (await page.locator('.thinking').count()) === 1);
  await page.getByRole('button', { name: '+ New conversation' }).click();
  await pause(300);
  check('U10 no thinking in another conversation', (await page.locator('.thinking').count()) === 0);
  const hint = await page.locator('.composer-hint').innerText();
  check('U10 hint explains the wait', hint.startsWith('Waiting for the reply'), hint);
  await page.getByLabel('Message the assistant').fill('second');
  check(
    'U10 Send disabled elsewhere during the turn',
    await page.getByLabel('Send message').isDisabled(),
  );
  await page.getByLabel('Conversation', { exact: true }).selectOption(id);
  await page.waitForSelector('.thinking');
  check('U10 thinking back in its conversation', (await page.locator('.thinking').count()) === 1);
  release();
  await page.waitForFunction(() => !document.querySelector('.thinking'));
  await ctx.close();
});

await scenario('U10 short ref', async () => {
  const { ctx, page } = await open();
  const id = await firstConversation(page);
  const uuid = '1a2b3c4d-5e6f-7a8b-9c0d-112233445566';
  await page.route(`**/api/conversations/${id}`, (route) =>
    json(route, 200, {
      messages: [
        msg('m1', 'user', 'Help'),
        msg('m2', 'assistant', `I opened case ${uuid} for you.`),
      ],
    }),
  );
  await page.getByLabel('Conversation', { exact: true }).selectOption(id);
  const text = await page.locator('.message.assistant').first().innerText();
  check(
    'U10 case UUID shown as short reference',
    /case #[0-9A-Z]{6} for you/.test(text) && !text.includes(uuid),
    text,
  );
  await ctx.close();
});

// Finding D (DV7): an outcome note added on the server shows on the next 20 s tick.
await scenario('D poll', async () => {
  const { ctx, page } = await open();
  const id = await firstConversation(page);
  const thread = [
    msg('m1', 'user', 'Send €5 to savings'),
    msg('m2', 'assistant', 'Pending verification.'),
  ];
  await page.route(`**/api/conversations/${id}`, (route) => json(route, 200, { messages: thread }));
  await page.getByLabel('Conversation', { exact: true }).selectOption(id);
  await page.waitForSelector('.message.assistant');
  thread.push(
    msg('m3', 'assistant', 'Transfer completed: €5.00 to savings.', {
      run_id: 'outcome:completed:x',
    }),
  );
  await page
    .locator('.message .outcome', { hasText: 'Transfer completed' })
    .waitFor({ timeout: 25_000 });
  check('D outcome note appears without reopening the conversation', true);
  await ctx.close();
});

await scenario('mobile', async () => {
  const { ctx, page } = await open(390, 844);
  const id = await firstConversation(page);
  check('mobile sidebar history hidden', !(await page.locator('.history').isVisible()));
  const pickers = await page
    .getByLabel('Conversation', { exact: true })
    .evaluateAll((els) => els.filter((e) => e.offsetParent).length);
  check('mobile exactly one visible conversation picker', pickers === 1, `visible=${pickers}`);
  const messages = Array.from({ length: 30 }, (_, i) =>
    msg(
      `m${i}`,
      i % 2 ? 'assistant' : 'user',
      `Message number ${i} with some text to fill the line.`,
    ),
  );
  await page.route(`**/api/conversations/${id}`, (route) => json(route, 200, { messages }));
  await page.getByLabel('Conversation', { exact: true }).selectOption(id);
  await page.waitForSelector('.message >> nth=29');
  await pause(500);
  const bottom = async () =>
    (await page.locator('.composer-box').boundingBox()).y +
    (await page.locator('.composer-box').boundingBox()).height;
  const before = await bottom();
  await page.locator('.messages').evaluate((el) => (el.scrollTop = 0));
  await pause(300);
  const after = await bottom();
  check(
    'mobile composer above the tab bar',
    before <= 844 - 76 && after <= 844 - 76,
    `bottom=${before}/${after}`,
  );
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  check('mobile no horizontal scroll', sw <= 390, `scrollWidth=${sw}`);
  await ctx.close();
});

await scenario('dropped items', async () => {
  const { ctx, page } = await open();
  const id = await firstConversation(page);
  await page.getByLabel('Conversation', { exact: true }).selectOption(id);
  await page.waitForSelector('.message');
  check(
    'no proposal card inside the thread',
    (await page.locator('.messages .proposal').count()) === 0,
  );
  check('no Context rail', (await page.getByText('Context', { exact: true }).count()) === 0);
  await ctx.close();
});

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
