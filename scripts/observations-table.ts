// OB1 (REQ-OB-8): `npm run observations:table [-- --today YYYY-MM-DD]` prints, for every seeded
// customer of the simulator and of the demo bank, the spending observation the server would pick
// on that day (plan 26 §7), its basis, and for each kind why. Rules only: no model, no key, no
// running app. `category_up` depends on the date, so the header always states it. The seeds are
// read as scripts/offers-table.ts reads them. No seed has a prepared transfer: one made-up row
// (pure input) shows `prepared_uncovered`.
import fs from 'node:fs';
import { setupEnv, startSimulator } from '../tests/helpers/bank';

process.env.DECIDER = 'none';
const { temp } = await setupEnv('banana-observations-table-');
Object.assign(process.env, {
  ALT_BANK_SEED_FILE: 'tests/alt-bank/demo-seed.json', // what `npm run demo` serves
  ALT_BANK_MOVEMENTS_LIMIT: '100',
});
const { seedBank } = await import('../simulator/seed');
const { closeBankDb } = await import('../simulator/db');
const { setScenario } = await import('../simulator/bank');
const { seedApp } = await import('../src/seed');
const { closeAppDb } = await import('../src/db');
const { bankView } = await import('../src/banking/view');
const { today: realToday } = await import('../src/banking/prepared');
const { explainObservations } = await import('../src/observations/detect');
const { people } = await import('../src/people');
type ObservationInput = import('../src/observations/detect').ObservationInput;

const at = process.argv.indexOf('--today');
const today = at < 0 ? realToday() : process.argv[at + 1];
if (!/^\d{4}-\d{2}-\d{2}$/.test(today ?? '')) throw new Error('--today takes a day, YYYY-MM-DD.');

const euros = (cents: number) =>
  `€${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
function row(name: string, input: ObservationInput) {
  const kinds = explainObservations(input);
  const picked = kinds.flatMap((k) => k.found)[0];
  console.log(
    `\n${name} — ${input.accounts.map((a) => `${a.label} ${euros(a.balanceCents)}`).join(', ')}`,
  );
  console.log(
    `  ${picked ? `${picked.kind} — ${picked.title}. ${picked.basis}` : 'no observation'}`,
  );
  for (const k of kinds)
    console.log(`    ${k.found.length ? 'found' : 'no   '} ${k.kind}: ${k.why}`);
  return picked;
}
let customers = 0,
  none = 0;
try {
  console.log(`Spending observations computed for ${today} (Europe/Madrid).`);
  for (const impl of ['simulator', 'alt'] as const) {
    if (impl === 'simulator') seedBank();
    seedApp();
    const bank = await startSimulator(impl);
    try {
      if (impl === 'simulator') setScenario('normal');
      console.log(`\n## ${impl === 'alt' ? 'Demo bank (npm run demo)' : 'Simulator'}`);
      for (const { id } of people.filter((p) => p.role === 'customer')) {
        const view = await bankView(id);
        const accounts = view.accounts as ObservationInput['accounts'];
        customers++;
        if (!row(id, { accounts, view, prepared: [], today })) none++;
        if (impl !== 'alt' || id !== 'lucia') continue;
        const main = accounts.find((a) => a.label === 'Aurora account')!;
        row(
          `lucia, with a made-up prepared transfer of ${euros(main.balanceCents + 50000)} from ${main.label}`,
          {
            accounts,
            view,
            today,
            prepared: [
              {
                id: 'made-up',
                fromAccountId: main.id,
                toAccountId: 'acc-carla',
                to: 'Carla Ríos',
                amountCents: main.balanceCents + 50000,
                concept: 'Deposit',
                note: null,
                when: { kind: 'manual' },
                nextDue: null,
                state: 'ready',
                approvalId: null,
                expiresAt: null,
                lastAttempt: null,
                lastSentAt: null,
              },
            ],
          },
        );
      }
    } finally {
      bank.kill();
    }
  }
  console.log(
    `\n${none} of ${customers} seeded customers get no observation on ${today} (the made-up row is not a seeded customer).`,
  );
} finally {
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
}
