// K7: numeric settings are validated at startup with a clear message; the development
// SESSION_SECRET is flagged once in production; an unparseable Origin ("null") is a 403, not a 500.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-config-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
// Loads src/config.ts in a fresh process, from a directory without .env files.
function loadConfig(env: Record<string, string>) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !/^(BANK_|APP_PORT|SESSION_SECRET|NODE_ENV|DATA_DIR|CASE_WAIT_|DECIDER|OPENAI_|OFFERS|OBSERVATIONS)/.test(
          k,
        ) && !k.startsWith('NODE_TEST'),
    ),
  );
  const config = path.resolve('src/config.ts');
  const r = spawnSync(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '-e',
      `const { config } = await import(${JSON.stringify(config)}); console.log(JSON.stringify(config));`,
    ],
    { cwd: temp, env: { ...clean, ...env } as NodeJS.ProcessEnv, encoding: 'utf8' },
  );
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('K7: numeric settings default and parse', () => {
  const r = loadConfig({ BANK_TIMEOUT_MS: '2500' });
  assert.equal(r.code, 0, r.stderr);
  const config = JSON.parse(r.stdout);
  assert.equal(config.bankTimeoutMs, 2500);
  assert.equal(config.bankPort, 4001);
  assert.equal(config.appPort, 3000);
});

for (const [name, value] of [
  ['BANK_TIMEOUT_MS', 'abc'],
  ['BANK_TIMEOUT_MS', '-5'],
  ['BANK_PORT', '40o1'],
  ['APP_PORT', '0'],
])
  test(`K7: ${name}=${value} stops startup naming the setting`, () => {
    const r = loadConfig({ [name]: value });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, new RegExp(`${name} must be a positive whole number, got "${value}"`));
  });

test('TR1 (REQ-TR-6): AI_PRICES parses to nano-dollars per token; a malformed value stops startup naming it', () => {
  const ok = loadConfig({ AI_PRICES: 'gpt-6-luna=0.1/0.01/0.5; my-model=0.042/-/0' });
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).aiPrices, {
    'gpt-6-luna': { input: 100, cached: 10, output: 500 },
    'my-model': { input: 42, cached: null, output: 0 },
  });
  for (const value of ['gpt-6-luna=0.1', 'gpt-6-luna=0.1/0.01/0.0005', 'x=a/b/c']) {
    const bad = loadConfig({ AI_PRICES: value });
    assert.notEqual(bad.code, 0, value);
    assert.match(bad.stderr, /AI_PRICES must be/);
  }
});

test('OPX2: case wait thresholds default to 60/240 and parse', () => {
  const d = loadConfig({});
  assert.equal(d.code, 0, d.stderr);
  assert.equal(JSON.parse(d.stdout).caseWaitWarnMinutes, 60);
  assert.equal(JSON.parse(d.stdout).caseWaitBreachMinutes, 240);
  const r = loadConfig({ CASE_WAIT_WARN_MINUTES: '15', CASE_WAIT_BREACH_MINUTES: '45' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).caseWaitWarnMinutes, 15);
  assert.equal(JSON.parse(r.stdout).caseWaitBreachMinutes, 45);
  assert.match(
    loadConfig({ CASE_WAIT_WARN_MINUTES: 'soon' }).stderr,
    /CASE_WAIT_WARN_MINUTES must be a positive whole number, got "soon"/,
  );
});

test('OPX2: warn >= breach stops startup naming both settings', () => {
  const r = loadConfig({ CASE_WAIT_WARN_MINUTES: '300', CASE_WAIT_BREACH_MINUTES: '60' });
  assert.notEqual(r.code, 0);
  assert.match(
    r.stderr,
    /CASE_WAIT_WARN_MINUTES \(300\) must be lower than CASE_WAIT_BREACH_MINUTES \(60\)/,
  );
});

test('K7: the default SESSION_SECRET is flagged in production only', () => {
  const warning = /SESSION_SECRET is the development default/;
  assert.match(loadConfig({ NODE_ENV: 'production' }).stderr, warning);
  assert.doesNotMatch(
    loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'a-real-secret' }).stderr,
    warning,
  );
  assert.doesNotMatch(loadConfig({}).stderr, warning);
});

// SI3: the decider settings (plan 23, contracts.md §5).
test('SI3: decider settings default and parse', () => {
  const d = loadConfig({});
  assert.equal(d.code, 0, d.stderr);
  const defaults = JSON.parse(d.stdout);
  assert.equal(defaults.decider, 'auto');
  assert.equal(defaults.deciderBaseUrl, 'https://api.typesafe.ai');
  assert.equal(defaults.deciderApiKey, '');
  assert.equal(defaults.deciderModel, 'jev-1.13.0');
  assert.equal(defaults.deciderThreshold, 0.8);
  assert.equal(defaults.deciderOpenaiThreshold, 0.85);
  assert.equal(defaults.deciderTimeoutMs, 10000);
  const r = loadConfig({
    DECIDER: 'systemone',
    DECIDER_BASE_URL: ' https://openrouter.ai/api// ',
    DECIDER_API_KEY: ' k-123 ',
    DECIDER_MODEL: 'jev-latest',
    DECIDER_THRESHOLD_PCT: '100',
    DECIDER_OPENAI_THRESHOLD_PCT: '1',
    DECIDER_TIMEOUT_MS: '2500',
  });
  assert.equal(r.code, 0, r.stderr);
  const config = JSON.parse(r.stdout);
  assert.equal(config.decider, 'systemone');
  assert.equal(config.deciderBaseUrl, 'https://openrouter.ai/api');
  assert.equal(config.deciderApiKey, 'k-123');
  assert.equal(config.deciderModel, 'jev-latest');
  assert.equal(config.deciderThreshold, 1);
  assert.equal(config.deciderOpenaiThreshold, 0.01);
  assert.equal(config.deciderTimeoutMs, 2500);
  for (const local of ['http://localhost:4999', 'http://127.0.0.1:4999/', 'http://[::1]:4999'])
    assert.equal(loadConfig({ DECIDER_BASE_URL: local }).code, 0, local);
  // DECIDER=openai with no OpenAI key is not an error: the app must start with no key.
  assert.equal(loadConfig({ DECIDER: 'openai' }).code, 0);
  assert.equal(loadConfig({ DECIDER: 'none' }).code, 0);
});

for (const [name, value] of [
  ['DECIDER', 'jev'],
  ['DECIDER', 'AUTO'],
  ['DECIDER_THRESHOLD_PCT', '0'],
  ['DECIDER_THRESHOLD_PCT', '101'],
  ['DECIDER_THRESHOLD_PCT', '80.5'],
  ['DECIDER_OPENAI_THRESHOLD_PCT', '0'],
  ['DECIDER_OPENAI_THRESHOLD_PCT', '101'],
  ['DECIDER_OPENAI_THRESHOLD_PCT', 'high'],
  ['DECIDER_TIMEOUT_MS', '0'],
  ['DECIDER_TIMEOUT_MS', 'fast'],
  ['DECIDER_BASE_URL', 'http://api.typesafe.ai'],
  ['DECIDER_BASE_URL', 'http://localhost.evil.example'],
  ['DECIDER_BASE_URL', 'ftp://localhost'],
  ['DECIDER_BASE_URL', 'api.typesafe.ai'],
  ['DECIDER_BASE_URL', 'https://user:pass@api.typesafe.ai'],
  // Reviewer of #92: look-alike hosts, credentials in other shapes, and URLs the path cannot follow.
  ['DECIDER_BASE_URL', 'http://localhost.evil.com'],
  ['DECIDER_BASE_URL', 'http://127.0.0.1.evil.com'],
  ['DECIDER_BASE_URL', 'http://localhost@evil.com'],
  ['DECIDER_BASE_URL', 'http://evil.com/localhost'],
  ['DECIDER_BASE_URL', 'http://evil.com#localhost'],
  ['DECIDER_BASE_URL', 'https://k-secret-123@api.typesafe.ai'],
  ['DECIDER_BASE_URL', 'https://api.typesafe.ai/?key=k-secret-123'],
  ['DECIDER_BASE_URL', 'https://api.typesafe.ai/api#frag'],
  ['DECIDER_BASE_URL', 'http://[::2]:4999'],
  ['DECIDER_BASE_URL', 'http://0.0.0.0:4999'],
  ['DECIDER_BASE_URL', 'file:///etc/passwd'],
])
  test(`SI3: ${name}=${value} stops startup naming the setting`, () => {
    const r = loadConfig({ [name]: value, DECIDER_API_KEY: 'k-secret-123' });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, new RegExp(`Error: ${name} must be `));
    assert.doesNotMatch(r.stderr + r.stdout, /k-secret-123/);
  });

test('SI3: DECIDER=systemone without a key stops startup naming DECIDER_API_KEY', () => {
  const r = loadConfig({ DECIDER: 'systemone' });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Error: DECIDER=systemone needs DECIDER_API_KEY\./);
  assert.notEqual(loadConfig({ DECIDER: 'systemone', DECIDER_API_KEY: '   ' }).code, 0);
});

// XS2: product suggestions (plan 24 §5).
test('XS2: OFFERS and OFFERS_COOLDOWN_DAYS default to on and 0, parse, and reject other values', () => {
  const d = JSON.parse(loadConfig({}).stdout);
  assert.deepEqual([d.offers, d.offersCooldownDays], ['on', 0]);
  const c = JSON.parse(loadConfig({ OFFERS: 'off', OFFERS_COOLDOWN_DAYS: '7' }).stdout);
  assert.deepEqual([c.offers, c.offersCooldownDays], ['off', 7]);
  assert.match(loadConfig({ OFFERS: 'yes' }).stderr, /OFFERS must be one of on, off, got "yes"/);
  assert.match(
    loadConfig({ OFFERS_COOLDOWN_DAYS: '-1' }).stderr,
    /OFFERS_COOLDOWN_DAYS must be a whole number \(0 means no cool-down\), got "-1"/,
  );
});

// OB1: spending observations (plan 26 §3).
test('OB1: OBSERVATIONS defaults to on, parses off, and rejects other values', () => {
  assert.equal(JSON.parse(loadConfig({}).stdout).observations, 'on');
  assert.equal(JSON.parse(loadConfig({ OBSERVATIONS: 'off' }).stdout).observations, 'off');
  assert.match(
    loadConfig({ OBSERVATIONS: 'no' }).stderr,
    /OBSERVATIONS must be one of on, off, got "no"/,
  );
});

test('K7: Origin "null" is a 403, not a 500', async () => {
  process.env.DATA_DIR = temp;
  const { POST } = await import('../app/api/[...path]/route');
  const post = (origin: string) =>
    POST(
      new Request('http://localhost/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', origin, host: 'localhost' },
        body: JSON.stringify({ userId: 'lucia' }),
      }),
      { params: Promise.resolve({ path: ['session'] }) },
    );
  const r = await post('null');
  assert.equal(r.status, 403);
  assert.equal(((await r.json()) as { error: string }).error, 'Origin not allowed.');
  assert.equal((await post('http://localhost')).status, 200);
});
