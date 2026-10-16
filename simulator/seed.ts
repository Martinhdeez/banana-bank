import { bankDb } from './db';
import { people } from '../src/people';
export function seedBank() {
  const db = bankDb();
  db.transaction(() => {
    db.exec(
      'DELETE FROM movements; DELETE FROM operations; DELETE FROM accounts; DELETE FROM scenario;',
    );
    const putAccount = db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?)');
    const putMovement = db.prepare('INSERT INTO movements VALUES(?,?,?,?,?,?)');
    const customers = people.filter((p) => p.role === 'customer');
    customers.forEach((p, i) => {
      const accountId = `acc-${p.id}`;
      const opening = p.id === 'diego' ? 7500 : 240000 + i * 31000;
      putAccount.run(
        accountId,
        p.id,
        i % 2 ? 'Horizon account' : 'Aurora account',
        `ES91 2100 0418 45${String(i + 1).padStart(10, '0')}`,
        opening,
      );
      putMovement.run(
        `opening-${p.id}`,
        accountId,
        null,
        opening,
        'Opening balance',
        '2026-08-01T09:00:00.000Z',
      );
      for (let j = 0; j < 5; j++) {
        const amount = j === 0 ? 175000 : -(1000 + (i + j) * 175);
        db.prepare('UPDATE accounts SET balanceCents=balanceCents+? WHERE id=?').run(
          amount,
          accountId,
        );
        putMovement.run(
          `movement-${p.id}-${j}`,
          accountId,
          null,
          amount,
          ['September salary', 'Groceries', 'Internet bill', 'Coffee shop', 'Transport'][j],
          `2026-09-${String(2 + j * 3).padStart(2, '0')}T10:00:00.000Z`,
        );
      }
      if (p.id === 'diego') {
        const current = (
          db.prepare('SELECT balanceCents FROM accounts WHERE id=?').get(accountId) as {
            balanceCents: number;
          }
        ).balanceCents;
        putMovement.run(
          'diego-savings',
          accountId,
          null,
          7500 - current,
          'Transfer to external savings',
          '2026-09-20T10:00:00.000Z',
        );
        db.prepare('UPDATE accounts SET balanceCents=7500 WHERE id=?').run(accountId);
      }
      if (i % 2 === 0) {
        const id = `acc-${p.id}-savings`;
        putAccount.run(
          id,
          p.id,
          'Personal savings',
          `ES22 2100 0418 46${String(i + 1).padStart(10, '0')}`,
          100000 + i * 20000,
        );
        putMovement.run(
          `opening-savings-${p.id}`,
          id,
          null,
          100000 + i * 20000,
          'Savings account opening',
          '2026-08-01T09:00:00.000Z',
        );
      }
    });
    const at = '2026-09-23T16:41:12.000Z';
    db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?)').run(
      'op-historic-lucia',
      'lucia',
      'ref-historic-lucia',
      'acc-lucia',
      'acc-bruno',
      8500,
      'Team dinner',
      at,
      'completed',
    );
    for (const [account, amount] of [
      ['acc-lucia', -8500],
      ['acc-bruno', 8500],
    ] as const) {
      db.prepare('UPDATE accounts SET balanceCents=balanceCents+? WHERE id=?').run(amount, account);
      putMovement.run(
        `historic-${account}`,
        account,
        'op-historic-lucia',
        amount,
        'Transfer · Team dinner',
        at,
      );
    }
    db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?)').run(
      'op-historic-elena',
      'elena',
      'ref-historic-elena',
      'acc-elena',
      'acc-hugo',
      2500,
      'Transfer to Hugo',
      '2026-09-23T16:42:10.000Z',
      'completed',
    );
    for (const [account, amount] of [
      ['acc-elena', -2500],
      ['acc-hugo', 2500],
    ] as const) {
      db.prepare('UPDATE accounts SET balanceCents=balanceCents+? WHERE id=?').run(amount, account);
      putMovement.run(
        `historic-${account}`,
        account,
        'op-historic-elena',
        amount,
        'Transfer · Transfer to Hugo',
        '2026-09-23T16:42:10.000Z',
      );
    }
    db.prepare('INSERT INTO scenario VALUES(1,?,?,0,0)').run('intermittent', 17);
  })();
}
