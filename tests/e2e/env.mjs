// Shared setup for the e2e suites (not a suite itself). Env: README "End-to-end checks".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Screenshots and downloads go only here, never into tracked folders: SHOTS, else a temp dir.
export const SHOTS = path.resolve(
  process.env.SHOTS || path.join(os.tmpdir(), 'bananabank-e2e-shots'),
);
fs.mkdirSync(SHOTS, { recursive: true });

export const APP_URL = process.env.APP_URL || 'http://127.0.0.1:3000';

// No default for these two: a guess could drive (or write into) the wrong bank or database.
function requireEnv(name, what) {
  if (process.env[name]) return process.env[name];
  console.log(`FAIL env — set ${name} to ${what}`);
  process.exit(1);
}
export const requireBankUrl = () =>
  requireEnv('BANK_URL', "the running app's bank, e.g. http://127.0.0.1:4001");
export const requireDataDir = () =>
  path.resolve(requireEnv('DATA_DIR', "the running app's data dir, e.g. .data-e2e"));

// PLAYWRIGHT_MODULE: another Playwright install; PLAYWRIGHT_CHANNEL=chrome: an installed Chrome
// (unset or empty: Playwright's bundled Chromium).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
export const launch = () =>
  chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });

// Suites that read the seeded fixtures (conversations, cases, document index) call this first.
// They cannot seed from here: the seed needs the app's DATA_DIR and `npm run reset` refuses while
// the app runs. So an unseeded app fails fast with one clear line instead of 30 s timeouts.
export async function requireSeed(url) {
  const session = await fetch(`${url}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'lucia' }),
  });
  const cookie = session.headers.get('set-cookie')?.split(';')[0] ?? '';
  const r = await fetch(`${url}/api/conversations/conv-lucia-support`, { headers: { cookie } });
  if (r.ok) return;
  console.log(
    `FAIL seed — ${url} has no seeded data (conv-lucia-support: ${r.status}). ` +
      'Stop the app, run `DATA_DIR=<its data dir> npm run reset` (or `npm run setup` on a new dir), start it again.',
  );
  process.exit(1);
}
