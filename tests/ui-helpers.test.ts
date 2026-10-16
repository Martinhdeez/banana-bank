import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mainAccount } from '../src/banking/recipients';
import {
  accountActivity,
  accountName,
  activityRows,
  excerptText,
  RELEVANT_SCORE,
  relevantSources,
  stripDocHeader,
  centsFromEuros,
  duplicateProposals,
  formatDate,
  paidLine,
  parseMessage,
  parseInline,
  parseTab,
  readJson,
  shortRefs,
  outcomeTone,
  outcomeUnknown,
  shortRef,
  transferFeedback,
  TRANSFER_STATUS_LABELS,
} from '../src/ui-helpers';
import { INTENT_STATUSES } from '../src/types';

// U3: a failed or pending transfer is never shown with the success style.
test('U3 a failed transfer is shown as an error with its explanation', () => {
  assert.deepEqual(transferFeedback({ status: 'failed', error: 'Insufficient funds: …' }), {
    tone: 'error',
    text: 'Insufficient funds: …',
  });
});
test('U3 a pending transfer is a warning that does not invite a retry', () => {
  const { tone, text } = transferFeedback({ status: 'pending_verification' });
  assert.equal(tone, 'warning');
  assert.doesNotMatch(text, /try again|retry/i);
});
test('U3 only completed transfers are notices; R1 a proposal is pending, not a notice', () => {
  assert.equal(transferFeedback({ status: 'completed' }).tone, 'notice');
  assert.equal(transferFeedback({ status: 'requires_confirmation' }).tone, 'pending');
  assert.match(transferFeedback({ status: 'requires_confirmation' }).text, /No money has moved/);
  assert.equal(transferFeedback({ status: 'processing' }).tone, 'warning');
  assert.equal(transferFeedback({}).tone, 'error');
});
test('U8 approvals show account labels and contact names, not raw ids', () => {
  const dashboard = {
    accounts: [{ id: 'acc-lucia', label: 'Aurora account' }],
    contacts: [{ id: 'acc-bruno', label: 'Horizon account', name: 'Bruno Vidal' }],
  };
  assert.equal(accountName('acc-lucia', dashboard), 'Aurora account');
  assert.equal(accountName('acc-bruno', dashboard), 'Bruno Vidal · Horizon account');
  assert.equal(accountName('acc-unknown', dashboard), 'acc-unknown');
});

test('X5 one date format, with year, optional time', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'UTC';
  try {
    assert.match(formatDate('2026-09-23T16:41:12.000Z'), /^23 Sept? 2026, 16:41$/);
    assert.match(formatDate(new Date('2026-09-29T08:00:00Z'), false), /^29 Sept? 2026$/);
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test('X3 identical pending proposals are flagged, different ones are not', () => {
  const p = (id: string, amountCents: number, concept: string) => ({
    id,
    payload: { fromAccountId: 'acc-lucia', toAccountId: 'acc-carla', amountCents, concept },
  });
  const ids = duplicateProposals([
    p('a', 1500, 'Cinema'),
    p('b', 1500, ' cinema '),
    p('c', 1600, 'Cinema'),
  ]);
  assert.deepEqual([...ids].sort(), ['a', 'b']);
  assert.equal(duplicateProposals([p('a', 1500, 'Cinema')]).size, 0);
});

test('K4 the UI uses the server duplicate rule: a reworded concept is still a duplicate', () => {
  const p = (id: string, concept: string) => ({
    id,
    payload: { fromAccountId: 'acc-lucia', toAccountId: 'acc-carla', amountCents: 1500, concept },
  });
  assert.deepEqual(
    [...duplicateProposals([p('a', 'Cinema'), p('b', 'Cinema tickets')])],
    ['a', 'b'],
  );
});

test('K4 every transfer status has a label and a known outcome state', () => {
  const all = [...INTENT_STATUSES, 'expired'] as const;
  assert.deepEqual(Object.keys(TRANSFER_STATUS_LABELS).sort(), [...all].sort());
  for (const status of all) assert.match(TRANSFER_STATUS_LABELS[status], /^[A-Z][a-z ]+$/);
  assert.deepEqual(
    all.filter((s) => outcomeUnknown(s)),
    ['processing', 'pending_verification'],
  );
});

test('R6 outcomeTone marks server-stored transfer outcome messages', () => {
  assert.equal(outcomeTone('outcome:notice:0b1c-run:call_abc'), 'notice');
  assert.equal(outcomeTone('outcome:warning:lucia:form-1'), 'warning');
  assert.equal(outcomeTone('0b1c-run'), null);
  assert.equal(outcomeTone(null), null);
});

test('U7 readJson returns JSON bodies and uses the error field', async () => {
  assert.deepEqual(await readJson(Response.json({ ok: 1 })), { ok: 1 });
  assert.deepEqual(await readJson(new Response(null, { status: 204 })), {});
  await assert.rejects(readJson(Response.json({ error: 'Nope.' }, { status: 403 })), {
    message: 'Nope.',
  });
});

test('U7 readJson tolerates non-JSON error bodies', async () => {
  const html = new Response('<html>Bad gateway</html>', { status: 502 });
  await assert.rejects(readJson(html), {
    message: 'The request could not be completed (502).',
  });
  await assert.rejects(readJson(new Response('<html>ok?</html>')), {
    message: 'The server sent an unexpected response.',
  });
});

test('U6 paragraphs split on blank lines, single newlines kept', () => {
  assert.deepEqual(parseMessage('Hello\nthere\n\nSecond'), [
    { kind: 'p', inlines: [{ kind: 'text', text: 'Hello\nthere' }] },
    { kind: 'p', inlines: [{ kind: 'text', text: 'Second' }] },
  ]);
});

test('U6 bullet and numbered lists', () => {
  const blocks = parseMessage(
    'Options:\n- **Aurora**: free\n* Horizon\n\n• Nova\n2. two\n3) three',
  );
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0], { kind: 'p', inlines: [{ kind: 'text', text: 'Options:' }] });
  assert.deepEqual(blocks[1], {
    kind: 'ul',
    items: [
      [
        { kind: 'strong', text: 'Aurora' },
        { kind: 'text', text: ': free' },
      ],
      [{ kind: 'text', text: 'Horizon' }],
      [{ kind: 'text', text: 'Nova' }],
    ],
  });
  assert.deepEqual(blocks[2], {
    kind: 'ol',
    start: 2,
    items: [[{ kind: 'text', text: 'two' }], [{ kind: 'text', text: 'three' }]],
  });
});

test('U6 bold at line start is not a bullet', () => {
  assert.deepEqual(parseMessage('**Note** read this'), [
    {
      kind: 'p',
      inlines: [
        { kind: 'strong', text: 'Note' },
        { kind: 'text', text: ' read this' },
      ],
    },
  ]);
});

test('U6 markdown and bare links, trailing punctuation excluded', () => {
  assert.deepEqual(parseInline('See [fees](https://bank.test/fees) or https://bank.test/x.'), [
    { kind: 'text', text: 'See ' },
    { kind: 'link', text: 'fees', href: 'https://bank.test/fees' },
    { kind: 'text', text: ' or ' },
    { kind: 'link', text: 'https://bank.test/x', href: 'https://bank.test/x' },
    { kind: 'text', text: '.' },
  ]);
  assert.deepEqual(parseInline('[mail](mailto:help@bank.test)'), [
    { kind: 'link', text: 'mail', href: 'mailto:help@bank.test' },
  ]);
});

test('U6 unsafe schemes and HTML stay plain text', () => {
  for (const raw of [
    '[click](javascript:alert(1))',
    '[x](data:text/html;base64,AAAA)',
    '<img src=x onerror=alert(1)> <script>alert(1)</script>',
  ]) {
    const inlines = parseInline(raw);
    assert.ok(
      inlines.every((i) => i.kind === 'text'),
      raw,
    );
    assert.equal(inlines.map((i) => i.text).join(''), raw);
  }
});

test('U6 unclosed bold stays literal', () => {
  assert.deepEqual(parseInline('a **b'), [{ kind: 'text', text: 'a **b' }]);
});

// R4 (ALT-1): newest first whatever the bank order, with the account each movement belongs to.
test('R4 activity rows are newest first and name the account', () => {
  const rows = activityRows({
    accounts: [
      { id: 'acc-carla', label: 'Aurora account' },
      { id: 'acc-carla-savings', label: 'Personal savings' },
    ],
    movements: [
      {
        id: 'm1',
        accountId: 'acc-carla',
        amountCents: -100,
        description: 'Old',
        createdAt: '2026-09-01T10:00:00.000Z',
      },
      {
        id: 'm2',
        accountId: 'acc-carla-savings',
        amountCents: 500,
        description: 'New',
        createdAt: '2026-09-20T10:00:00.000Z',
      },
    ],
  });
  assert.deepEqual(
    rows.map((r) => [r.id, r.account]),
    [
      ['m2', 'Personal savings'],
      ['m1', 'Aurora account'],
    ],
  );
});

// Shared fixture: R3/R4 and the U7 (round 4) filter.
const accounts = [
  { id: 'acc-lucia', label: 'Aurora account' },
  { id: 'acc-lucia-savings', label: 'Personal savings' },
];
const contacts = [
  { id: 'acc-hugo', name: 'Hugo Pérez', label: 'Horizon account' },
  { id: 'acc-carla', name: 'Carla Ríos', label: 'Aurora account' },
];
const at = (h: number) => `2026-09-29T${String(h).padStart(2, '0')}:00:00.000Z`;
const books = {
  fromAccountId: 'acc-lucia',
  toAccountId: 'acc-hugo',
  amountCents: 123,
  concept: 'Books',
};
const r34: Parameters<typeof activityRows>[0] = {
  accounts,
  contacts,
  approvals: [{ id: 'ap1', expires_at: at(9), payload: books }],
  transfers: [
    {
      intentId: 'i1',
      status: 'pending_verification',
      transfer: { ...books, concept: 'Late' },
      steps: [{ at: at(8) }],
    },
    { intentId: 'i2', status: 'completed', transfer: books, steps: [{ at: at(7) }] },
  ],
  movements: [
    {
      id: 'm1',
      accountId: 'acc-lucia',
      amountCents: -100,
      description: 'Coffee',
      createdAt: at(1),
    },
    {
      id: 'm2',
      accountId: 'acc-lucia',
      amountCents: 500,
      description: 'Transfer · Rent',
      createdAt: at(3),
      operationId: 'op1',
      fromAccountId: 'acc-carla',
      toAccountId: 'acc-lucia',
      concept: 'Rent',
    },
    {
      id: 'm3',
      accountId: 'acc-lucia',
      amountCents: -700,
      description: 'Transfer · Save',
      createdAt: at(4),
      operationId: 'op2',
      fromAccountId: 'acc-lucia',
      toAccountId: 'acc-lucia-savings',
      concept: 'Save',
    },
    {
      id: 'm4',
      accountId: 'acc-lucia-savings',
      amountCents: 700,
      description: 'Transfer · Save',
      createdAt: at(4),
      operationId: 'op2',
    },
    {
      id: 'm5',
      accountId: 'acc-lucia',
      amountCents: -200,
      description: 'Transfer · Gift',
      createdAt: at(2),
      operationId: 'op3',
      fromAccountId: 'acc-lucia',
      toAccountId: 'acc-hugo',
      concept: 'Gift',
    },
  ],
};

// R3: proposals and transfers being verified lead Recent activity with their own kind.
// R4: counterparty names, one row for a move between own accounts, the account it hit.
test('R3/R4 activity rows: pending first, named counterparties, internal moves once', () => {
  const rows = activityRows(r34);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.title, r.amountCents, r.account]),
    [
      ['pending', 'To Hugo Pérez · Horizon account', 123, 'Aurora account'],
      ['verifying', 'To Hugo Pérez · Horizon account', -123, 'Aurora account'],
      ['internal', 'Between your accounts', 700, 'Personal savings'],
      ['movement', 'Received from Carla Ríos · Aurora account', 500, 'Aurora account'],
      ['movement', 'Sent to Hugo Pérez · Horizon account', -200, 'Aurora account'],
      ['movement', 'Coffee', -100, 'Aurora account'],
    ],
  );
  assert.match(rows[2].detail, /Save · Aurora account → Personal savings/);
  assert.equal(rows[3].detail, 'Rent');
  assert.equal(activityRows({ accounts, movements: [] }).length, 0);
});

// U7 (round 4): a proposal is not money gone: unsigned amount, the concept alone as detail.
test('U7 pending rows are not money gone', () => {
  const pending = activityRows(r34).find((r) => r.kind === 'pending')!;
  assert.equal(pending.amountCents, 123);
  assert.equal(pending.detail, 'Books');
});

// U7 (round 4): the account filter keeps internal moves, as that account's signed leg.
test('Filter keeps internal moves', () => {
  const savings = accountActivity(r34, 'acc-lucia-savings');
  assert.deepEqual(
    savings.map((r) => [r.title, r.amountCents]),
    [['Between your accounts', 700]],
  );
  assert.match(savings[0].detail, /Save · Aurora account → Personal savings/);
  const main = accountActivity(r34, 'acc-lucia', Infinity);
  const internal = main.filter((r) => r.title === 'Between your accounts');
  assert.deepEqual(
    internal.map((r) => r.amountCents),
    [-700],
  );
  assert.ok(main.every((r) => r.accountId === 'acc-lucia'));
  assert.deepEqual(accountActivity(r34, null), activityRows(r34));
  // An internal leg whose pair is missing still reads as a move between own accounts.
  const lone = activityRows({ ...r34, movements: r34.movements!.filter((m) => m.id === 'm3') });
  assert.equal(lone.find((r) => r.id === 'm3')?.title, 'Between your accounts');
});

test('mainAccount is the first non-savings account whatever the order', () => {
  const main = { id: 'a', label: 'Aurora account' },
    savings = { id: 's', label: 'Personal savings' };
  assert.equal(mainAccount([savings, main]), main);
  assert.equal(mainAccount([main, savings]), main);
  assert.equal(mainAccount([savings]), savings);
});

// U5 (round 4): the tab in the URL, only when valid for the role.
test('U5 parseTab keeps a valid tab and falls back to the role default', () => {
  assert.equal(parseTab('?tab=transfers', 'customer'), 'transfers');
  assert.equal(parseTab('?tab=cases', 'customer'), 'overview');
  assert.equal(parseTab('?tab=transfers', 'operator'), 'cases');
  assert.equal(parseTab('', 'operator'), 'cases');
  assert.equal(parseTab('?tab=documents', 'operator'), 'documents');
});

// U10: short case reference; the seeded readable ids (fixtures/conversations.json) must not collide.
test('U10 shortRef is a stable #XXXXXX reference, distinct for every seeded case', () => {
  const seeded: string[] = JSON.parse(readFileSync('fixtures/conversations.json', 'utf8'))
    .filter((h: { case?: { id: string } }) => h.case)
    .map((h: { case: { id: string } }) => h.case.id);
  assert.ok(seeded.includes('case-lucia'));
  assert.ok(seeded.filter((id) => id.startsWith('case-routine-')).length > 1);
  const ids = [...seeded, '1a2b3c4d-5e6f-7a8b-9c0d-112233445566'];
  for (const id of ids) {
    assert.match(shortRef(id), /^#[0-9A-Z]{6}$/);
    assert.equal(shortRef(id), shortRef(id));
  }
  assert.equal(new Set(ids.map(shortRef)).size, ids.length);
});

// U11 (round 4): relevance cut-off and customer-readable excerpts.
test('U11 relevantSources drops a nonsense query and keeps a relevant one', () => {
  // .scratch/audit-04/ux/walk1b.txt: nonsense top hit 0.184; "Aurora fee" hits 0.567–0.665.
  assert.ok(RELEVANT_SCORE > 0.184 && RELEVANT_SCORE < 0.567);
  assert.deepEqual(relevantSources([{ id: 'x', score: 0.184 }]), []);
  const hits = [
    { id: 'a', score: 0.665 },
    { id: 'b', score: 0.567 },
    { id: 'c', score: 0.2 },
  ];
  assert.deepEqual(
    relevantSources(hits).map((s) => s.id),
    ['a', 'b'],
  );
});

test('U11 excerptText strips the chunk header, "#" marks and the document id line', () => {
  assert.equal(
    excerptText('Aurora · fees\n## Terms\n\nThe fee is EUR 6.\n## Waiver\nBoth needed.'),
    'The fee is EUR 6.\nWaiver\nBoth needed.',
  );
  assert.equal(excerptText('No header'), 'No header');
  const intro = excerptText(
    'Aurora · fees\n\nDocument aurora-fees-2026. Version 2. Effective from 2026-09-01. Audience: customers.\n\nThis document belongs to Banana Bank.',
  );
  assert.equal(intro, 'This document belongs to Banana Bank.');
});

test('U11 stripDocHeader drops only the title line and the metadata paragraph', () => {
  const text =
    '# Aurora · fees\n\nDocument aurora-fees-2026. Version 2. Effective from 2026-09-01. Audience: customers.\n\nBody.\n\n## Terms\n\nFee.';
  assert.equal(stripDocHeader(text), 'Body.\n\n## Terms\n\nFee.');
  assert.equal(stripDocHeader('Plain text.'), 'Plain text.');
});

// U3: the form estimate uses the server's strict parser (moved here from src/banking/actions.ts).
test('U3 centsFromEuros accepts comma decimals and refuses loose formats', () => {
  assert.equal(centsFromEuros('12,50'), 1250);
  assert.equal(centsFromEuros('1e3'), null);
  assert.equal(centsFromEuros(' 7 '), 700);
  assert.equal(centsFromEuros('1.234'), null);
});

// U10: a case UUID in an assistant message reads as the short reference used in Cases.
test('U10 shortRefs shortens UUIDs for display and leaves other text alone', () => {
  const id = '1a2b3c4d-5e6f-7a8b-9c0d-112233445566';
  assert.equal(shortRefs(`Case ${id} opened`), `Case ${shortRef(id)} opened`);
  assert.equal(shortRefs(`Case ${id.toUpperCase()} opened`), `Case ${shortRef(id)} opened`);
  assert.equal(shortRefs('No reference here, 1a2b-3c4d.'), 'No reference here, 1a2b-3c4d.');
});

test('CF8 Paid line: newest payment across the person, short date, none when never paid', () => {
  const now = new Date('2026-09-30T12:00:00Z'),
    accounts = [{ id: 'acc-hugo' }, { id: 'acc-hugo-savings' }],
    recent = [
      { accountId: 'acc-carla', lastAt: '2026-09-29T12:00:00Z' },
      { accountId: 'acc-hugo', lastAt: '2026-09-20T12:00:00Z' },
      { accountId: 'acc-hugo-savings', lastAt: '2026-09-23T12:00:00Z' },
    ];
  assert.match(paidLine(accounts, recent, now) ?? '', /^Paid 23 Sept?$/);
  assert.equal(paidLine([{ id: 'acc-bruno' }], recent, now), undefined);
  assert.match(
    paidLine(accounts, [{ accountId: 'acc-hugo', lastAt: '2025-12-10T12:00:00Z' }], now) ?? '',
    /^Paid 10 Dec 2025$/,
  );
});
