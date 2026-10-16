// XS5 (REQ-XS-22): `npm run offers:table` prints, for every seeded customer of the simulator and
// of the demo bank, which offer the server would choose (plan 24 §7) — from the accounts alone and
// with the movements read — its basis, and why each other offer is not the one. Rules only: no
// model, no key, no running app. The seeds are read the way tests/xs1-offers.test.ts reads them:
// each bank is started on a free port over a temporary data directory and read through the app's
// own bank view.
import fs from 'node:fs';
import { setupEnv, startSimulator } from '../tests/helpers/bank';

process.env.DECIDER = 'none';
const { temp } = await setupEnv('banana-offers-table-');
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
const { explainOffers } = await import('../src/offers/select');
const { people } = await import('../src/people');
type OfferInput = import('../src/offers/select').OfferInput;

const euros = (cents: number) =>
  `€${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
let customers = 0,
  none = 0;
try {
  for (const impl of ['simulator', 'alt'] as const) {
    if (impl === 'simulator') seedBank();
    seedApp();
    const bank = await startSimulator(impl);
    try {
      if (impl === 'simulator') setScenario('normal');
      console.log(`\n## ${impl === 'alt' ? 'Demo bank (npm run demo)' : 'Simulator'}`);
      for (const { id } of people.filter((p) => p.role === 'customer')) {
        const view = await bankView(id);
        const accounts = view.accounts as OfferInput['accounts'];
        console.log(
          `\n${id} — ${accounts.map((a) => `${a.label} ${euros(a.balanceCents)}`).join(', ')}`,
        );
        let chosen;
        for (const [label, input] of [
          ['accounts only', { accounts, view: null, exclude: [] }],
          [`with movements (${view.movements.length})`, { accounts, view, exclude: [] }],
        ] as [string, OfferInput][]) {
          const all = explainOffers(input);
          // The first eligible offer in catalogue order is the one selectOffer returns.
          chosen = all.find((o) => o.eligible);
          console.log(`  ${label}: ${chosen ? `${chosen.id} — ${chosen.basis}` : 'no offer'}`);
          for (const o of all)
            if (o !== chosen)
              console.log(`    ${o.eligible ? 'also fits' : 'no       '} ${o.id}: ${o.why}`);
        }
        customers++;
        if (!chosen) none++;
      }
    } finally {
      bank.kill();
    }
  }
  console.log(`\n${none} of ${customers} seeded customers get no offer with their movements read.`);
} finally {
  closeAppDb();
  closeBankDb();
  fs.rmSync(temp, { recursive: true, force: true });
}
