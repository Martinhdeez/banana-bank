// GL5: a savings goal gets a representative name. The model is told to always name the goal after
// what the customer saves for (never a generic name), and the server stores the name with its
// first letter capitalised, the rest as the customer said it. Local fake of the OpenAI API.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupEnv, startSimulator, callApi } from './helpers/bank';
import { call, fakeOpenAI, say } from './helpers/openai';

for (const level of ['info', 'warn', 'error'] as const) console[level] = () => {};
const { temp } = await setupEnv('banana-gl5-');
process.env.OFFERS = 'off';
const openai = await fakeOpenAI(() => say('ok'));
const { seedBank } = await import('../simulator/seed');
const { setScenario } = await import('../simulator/bank');
const { closeBankDb } = await import('../simulator/db');
const { seedApp } = await import('../src/seed');
const { appDb, closeAppDb } = await import('../src/db');
const { today, occurrence } = await import('../src/banking/prepared');
const { goalToolDefinitions, goalsInstructions } = await import('../src/agent/goals');
seedApp();
seedBank();
const bank = await startSimulator();
setScenario('normal');
after(() => {
  bank.kill();
  openai.server.closeAllConnections();
  openai.server.close();
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('GL5: the model is told to always give the goal a short, representative name', () => {
  const name = (goalToolDefinitions.find((d) => d.name === 'plan_goal')!.parameters as any)
    .properties.name.description as string;
  for (const said of [name, goalsInstructions]) {
    assert.match(said, /representative name/);
    assert.match(said, /2.4 words/);
    assert.match(said, /Viaje a Lisboa/);
    assert.match(said, /never a generic name/i);
  }
  assert.match(goalsInstructions, /ask what it is for/);
});

test('GL5: a lowercase name is stored with its first letter capitalised, the rest untouched', async () => {
  const id = (await callApi('lucia', 'conversations', {})).body.id as string;
  const target = { targetCents: 120_000, targetDate: occurrence(today(), 28, 5) };
  const turn = async (content: string, script: () => object) => {
    openai.script.length = 0;
    openai.script.push(script);
    await callApi('lucia', `conversations/${id}/messages`, { content });
  };
  await turn('Quiero ahorrar 1.200 € para un viaje a Lisboa', () =>
    call('plan_goal', { name: 'viaje a Lisboa', ...target }),
  );
  await turn('Create this goal', () => call('create_goal', {}));
  assert.deepEqual(appDb().prepare('SELECT name FROM goals').pluck().all(), ['Viaje a Lisboa']);
});
