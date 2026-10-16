// GL6: when the customer names no day, a savings goal's monthly payment falls on the 3rd, early
// in the month; the model is told so. The money still waits in Transfers. Local fake of OpenAI.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupEnv, startSimulator, callApi } from './helpers/bank';
import { call, fakeOpenAI, say } from './helpers/openai';

for (const level of ['info', 'warn', 'error'] as const) console[level] = () => {};
const { temp } = await setupEnv('banana-gl6-');
process.env.OFFERS = 'off';
const openai = await fakeOpenAI(() => say('ok'));
const { seedBank } = await import('../simulator/seed');
const { setScenario } = await import('../simulator/bank');
const { closeBankDb } = await import('../simulator/db');
const { seedApp } = await import('../src/seed');
const { closeAppDb } = await import('../src/db');
const { today, occurrence } = await import('../src/banking/prepared');
const { goalToolDefinitions } = await import('../src/agent/goals');
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

test('GL6: the model is told the default payment day is the 3rd', () => {
  const day = (goalToolDefinitions.find((d) => d.name === 'plan_goal')!.parameters as any)
    .properties.day.description as string;
  assert.match(day, /3rd/);
});

test('GL6: a goal planned in the chat without a day pays on the 3rd', async () => {
  const id = (await callApi('lucia', 'conversations', {})).body.id as string;
  const target = { targetCents: 120_000, targetDate: occurrence(today(), 28, 5) };
  openai.script.length = 0;
  openai.script.push(() => call('plan_goal', { name: 'Viaje a Lisboa', ...target }));
  await callApi('lucia', `conversations/${id}/messages`, { content: 'Ahorrar 1.200 €' });
  const { messages } = (await callApi('lucia', `conversations/${id}`)).body;
  const card = messages.at(-1).extras.goalPlan;
  assert.equal(card.day, 3);
  assert.equal(card.firstDue.slice(8), '03');
});
