// CAT1: the spend category `work` ("Work & projects", plan 23, contracts.md 2.36). Its rules name
// only merchants that are work whoever pays them; one that can be personal stays where it was.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupEnv } from './helpers/bank';
import { applyRules } from '../src/insights/rules';
import { namedCategories } from '../src/insights/guard';
import { DECIDER_OPTIONS, categoryLabel } from '../src/insights/taxonomy';
import type { CategoryId, MovementInput } from '../src/insights/taxonomy';
import type { Decider } from '../src/insights/decider';
const { temp } = await setupEnv('banana-cat1-');
const { closeAppDb } = await import('../src/db');
const { classifyMovements } = await import('../src/insights/classify');
after(() => {
  closeAppDb();
  fs.rmSync(temp, { recursive: true, force: true });
});

let seq = 0;
const mv = (description: string, amountCents = -2500): MovementInput => ({
  id: `cat1-${++seq}`,
  accountId: 'acc-a',
  amountCents,
  description,
  createdAt: '2026-09-16T10:00:00.000Z',
});
const ctx = {
  ownAccountIds: new Set(['acc-a']),
  ownPairOperationIds: new Set<string>(),
  userRules: new Map<string, CategoryId>(),
};
const rule = (description: string) => applyRules(mv(description), ctx)?.category ?? null;

test('CAT1: each work rule names its merchant work; a merchant that can be personal is not', () => {
  for (const text of [
    'CUOTA AUTONOMOS TGSS',
    'TESORERIA GENERAL DE LA SEGURIDAD SOCIAL RETA 09/2026',
    'SEGURIDAD SOCIAL AUTONOMOS',
    'ADOBE *CREATIVE CLOUD',
    'GITHUB, INC. SAN FRANCISCO US',
    'JETBRAINS S.R.O. PRAHA',
    'FIGMA MONTHLY',
    'NOTION LABS INC',
    'ATLASSIAN PTY LTD',
    'MICROSOFT*365 BUSINESS',
    'HETZNER ONLINE GMBH',
    'DIGITALOCEAN.COM',
    'OVHCLOUD FACTURA',
    'GODADDY.COM DOMAIN',
    'AWS EMEA',
    'AMAZON WEB SERVICES EMEA SARL',
    'WEWORK MADRID',
    'COWORKING EL HUB',
    'UDEMY ONLINE COURSE',
    'COURSERA 8392',
    'PLATZI.COM',
  ])
    assert.equal(rule(text), 'work', text);
  for (const [text, was] of [
    ['AMZN Mktp ES*7HH21MM04', null],
    ['AMAZON.ES COMPRA', null],
    ['APPLE.COM/BILL', null],
    ['GOOGLE *YouTube', null],
    ['MICROSOFT*XBOX', null],
    ['PAYPAL *SPOTIFY 35314369001', 'eating_out_leisure'],
    ['NETFLIX.COM', 'eating_out_leisure'],
    ['MOVISTAR FIBRA', 'home_utilities'],
    ['BIZUM ENVIADO pago trabajo web', 'transfer_person'],
  ] as const)
    assert.equal(rule(text), was, text);
});

test('CAT1: a decider may answer work, and the guard withholds it when the text names it', async () => {
  assert.ok(DECIDER_OPTIONS.includes('work'));
  assert.equal(categoryLabel('work'), 'Work & projects');
  for (const text of ['ZZQXV WORK', 'ZZQXV WORK & PROJECTS', 'ZZQXV TRABAJO', 'ZZQXV PROYECTOS'])
    assert.deepEqual(namedCategories(text), ['work'], text);
  assert.deepEqual(namedCategories('WEWORK NETWORKING'), []);
  const sure: Decider = {
    id: 'systemone',
    threshold: 0.8,
    classify: async () => ({ candidates: [{ category: 'work', p: 1 }], confidence: 1, model: 'f' }),
  };
  const [plain, named] = [mv('ZZQXV ALPHA'), mv('ZZQXV ALPHA proyecto')];
  const out = await classifyMovements({
    userId: 'cat1',
    movements: [plain, named],
    ownAccountIds: new Set(['acc-a']),
    deciders: [sure],
    wait: true,
  });
  const got = (m: MovementInput) => {
    const c = out.get(m.id)!;
    return [c.id, c.state, c.reason.split(':')[0]];
  };
  assert.deepEqual(got(plain), ['work', 'estimated', 'model']);
  assert.deepEqual(got(named), ['other', 'needs_review', 'named_in_text']);
});

test('CAT1: in the demo seed the work rows are Bruno’s and Omar’s, by rule, and no other row', () => {
  const seed = JSON.parse(fs.readFileSync('tests/alt-bank/demo-seed.json', 'utf8')) as {
    movements: MovementInput[];
  };
  const work = seed.movements
    .filter((m) => applyRules({ ...m, accountId: 'x' }, ctx)?.category === 'work')
    .map((m) => `${m.id} ${m.description}`);
  assert.deepEqual(work, [
    'demo-bruno-008 ADOBE *CREATIVE CLOUD',
    'demo-bruno-012 CUOTA AUTONOMOS TGSS',
    'demo-bruno-022 ADOBE *CREATIVE CLOUD',
    'demo-bruno-029 CUOTA AUTONOMOS TGSS',
    'demo-omar-004 GITHUB, INC. SAN FRANCISCO US',
    'demo-omar-016 GITHUB, INC. SAN FRANCISCO US',
    'demo-omar-026 NOTION LABS INC',
    'demo-omar-033 GITHUB, INC. SAN FRANCISCO US',
  ]);
});
