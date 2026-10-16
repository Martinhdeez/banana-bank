// Acceptance tests for the decider settings (SI3), written blind from
// docs/plan/23-spend-insights/contracts.md §5: REQ-CORE-20. Each case imports the configuration
// in a fresh process, from a directory without .env files (the pattern of tests/config.test.ts).
// Builders never edit this file.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-si4-config-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const CONFIG = path.resolve('src/config.ts');
const CLASSIFY = path.resolve('src/insights/classify.ts');
function runScript(script: string, extra: Record<string, string>) {
  const env: Record<string, string> = { DATA_DIR: temp, ...extra };
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !/^(DECIDER|OPENAI_|BANK_|APP_PORT|SESSION_SECRET|NODE_ENV|DATA_DIR)/.test(k) &&
        !k.startsWith('NODE_TEST'),
    ),
  );
  const r = spawnSync(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
    {
      cwd: temp,
      env: { ...clean, ...env } as NodeJS.ProcessEnv,
      encoding: 'utf8',
      timeout: 60000,
    },
  );
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const loadConfig = (env: Record<string, string>) =>
  runScript(`await import(${JSON.stringify(CONFIG)}); console.log('loaded');`, env);
// What the default chain does with a movement no rule knows.
const classifyUnknown = (env: Record<string, string>) =>
  runScript(
    `const { classifyMovements } = await import(${JSON.stringify(CLASSIFY)});
     const result = await classifyMovements({
       userId: 'core-20',
       movements: [{ id: 'm1', accountId: 'acc-a', amountCents: -1500, description: 'ZZQXV ALPHA', createdAt: '2026-09-15T10:00:00.000Z' }],
       ownAccountIds: new Set(['acc-a']),
     });
     console.log('RESULT ' + JSON.stringify(result.get('m1')));
     process.exit(0);`,
    env,
  );
function assertNoDecider(r: ReturnType<typeof runScript>) {
  assert.equal(r.code, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, r.stdout + r.stderr);
  const c = JSON.parse(line.slice(7));
  assert.equal(c.id, 'other');
  assert.equal(c.state, 'needs_review');
  assert.equal(c.source, 'none');
  assert.equal(c.reason, 'no_decider');
}

for (const [variable, value, env] of [
  ['DECIDER', 'banana', {}],
  ['DECIDER_THRESHOLD_PCT', '0', {}],
  ['DECIDER_THRESHOLD_PCT', '101', {}],
  ['DECIDER_OPENAI_THRESHOLD_PCT', '0', {}],
  ['DECIDER_OPENAI_THRESHOLD_PCT', '101', {}],
] as const)
  test(`REQ-CORE-20 ${variable}=${JSON.stringify(value)} stops the import with an error naming the variable`, () => {
    const r = loadConfig({ ...env, [variable]: value });
    assert.notEqual(r.code, 0, 'the import must throw');
    assert.match(r.stderr, new RegExp(`\\b${variable}\\b(?!_)`));
  });

test('REQ-CORE-20 DECIDER=systemone without a key stops the import with an error naming the variable', () => {
  const r = loadConfig({ DECIDER: 'systemone' });
  assert.notEqual(r.code, 0, 'the import must throw');
  assert.match(r.stderr, /\bDECIDER(_API_KEY)?\b(?!_)/);
});

test('REQ-CORE-20 the valid values import cleanly', () => {
  const valid: Record<string, string>[] = [
    {},
    { DECIDER: 'none' },
    { DECIDER: 'auto' },
    { DECIDER: 'openai' }, // no OpenAI key: an empty chain, not an error
    { DECIDER: 'systemone', DECIDER_API_KEY: 'k' },
    { DECIDER_THRESHOLD_PCT: '1', DECIDER_OPENAI_THRESHOLD_PCT: '100' },
  ];
  for (const env of valid) {
    const r = loadConfig(env);
    assert.equal(r.code, 0, `${JSON.stringify(env)}: ${r.stderr}`);
  }
});

test('REQ-CORE-20 with no keys and DECIDER unset the chain is empty', () => {
  assertNoDecider(classifyUnknown({}));
});

test('REQ-CORE-20 DECIDER=openai without an OpenAI key is an empty chain', () => {
  assertNoDecider(classifyUnknown({ DECIDER: 'openai' }));
});
