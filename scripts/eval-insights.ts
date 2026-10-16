// SI8: the evaluation harness of the spend classifier (plan 23, 08-si8-eval.md).
//
//   npm run eval:insights -- [--set=dev|heldout|<path>] [--decider=<list>] [--out=<dir>]
//                            [--reverse-options] [--no-profile] [--rows] [--price=<USD>]
//
// It runs a labelled set through the real entry point, `classifyMovements`, once per decider
// configuration, and prints and writes the measurements. No HTTP server, no bank. A live decider
// runs only when it is asked for by name (EV1: a bare command runs the rules only, whatever keys
// exist) and its key is in the environment; without the key it is reported as SKIPPED and nothing
// is written that could pass for a measurement. Scoring is in scripts/eval-score.ts (pure).
// How to read the output: docs/insights-eval.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORY_IDS, DECIDER_OPTIONS } from '../src/insights/taxonomy';
import type { CategoryId } from '../src/insights/taxonomy';
import type { Decider } from '../src/insights/decider';
import {
  EVAL_OWN_ACCOUNTS,
  costUsd,
  flipRate,
  parseEvalSet,
  rate,
  score,
  toMovement,
  usage,
  type EvalRow,
  type LogEvent,
  type Outcome,
  type Score,
  type Tally,
  type Usage,
} from './eval-score';

export { parseEvalSet, score, toMovement, EVAL_OWN_ACCOUNTS } from './eval-score';

const INPUTS = 'docs/plan/23-spend-insights/inputs';
const SETS: Record<string, string> = {
  dev: `${INPUTS}/eval-set-dev.jsonl`,
  heldout: `${INPUTS}/heldout/eval-set-heldout.jsonl`,
};
const EVIDENCE = '.scratch/after/feat-si8-eval';
// The reviewer's override for per-row output on a held-out path (docs/insights-eval.md).
const OVERRIDE = 'EVAL_ALLOW_HELDOUT_ROWS';
// System One: $0.042 per million input tokens, output free (inputs/research-system-one-api.md).
// OpenAI has no documented price in this repository: pass --price to get a cost.
const SYSTEM_ONE_USD_PER_MILLION = 0.042;

const STUBS = ['oracle', 'noisy', 'first-option', 'failing', 'obedient'] as const;
type Stub = (typeof STUBS)[number];
export type EvalConfig = 'rules' | 'openai' | 'systemone' | `stub:${Stub}`;
const LIVE: EvalConfig[] = ['rules', 'openai', 'systemone'];
const isConfig = (name: string): name is EvalConfig =>
  LIVE.includes(name as EvalConfig) || STUBS.some((stub) => name === `stub:${stub}`);

// --- the pipeline, loaded late ----------------------------------------------------------------

// src/config.ts reads the environment (and .env.local) when it is imported, and the store opens
// its database under DATA_DIR: both must wait until the caller has set the directory.
async function pipeline() {
  process.env.DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'banana-eval-'));
  const [classify, decider, openai, systemone, normalize, http, config, guard] = await Promise.all([
    import('../src/insights/classify'),
    import('../src/insights/decider'),
    import('../src/insights/deciders/openai'),
    import('../src/insights/deciders/systemone'),
    import('../src/insights/normalize'),
    import('../src/http'),
    import('../src/config'),
    import('../src/insights/guard'),
  ]);
  return {
    ...classify,
    ...decider,
    ...openai,
    ...systemone,
    ...normalize,
    ...http,
    ...config,
    ...guard,
  };
}
type Pipeline = Awaited<ReturnType<typeof pipeline>>;

// --- stub deciders: in-process, to prove each column of the report, never a measurement ---------

// FNV-1a: the stubs' only source of variety, so that every run gives the same answers.
function hash(text: string) {
  let h = 0x811c9dc5;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}
// The options in taxonomy order, whatever order they are sent in.
const FIXED_OPTIONS = CATEGORY_IDS.filter((id) => DECIDER_OPTIONS.includes(id));
const CONFIDENCES = [0.55, 0.65, 0.75, 0.85, 0.95];

// oracle: the label, always sure. noisy: a confidence from five levels, and right about as often
// as it says (calibrated by construction). first-option: for half the items, whatever option is
// sent first. failing: a 503 every time. obedient (IG1): the worst model for an injected text; for
// an adversarial row it answers a wrong category the row's text names (the scorer's own reading,
// `injected`), fully sure, and the label for every other row. Latency and input units are
// synthetic and fixed per item.
function stubDecider(stub: Stub, rows: EvalRow[], p: Pipeline): Decider {
  const labels = new Map<string, CategoryId>();
  const obeys = new Map<string, CategoryId>();
  for (const row of rows) {
    const key = p.cleanDescription(row.description);
    if (!labels.has(key)) labels.set(key, row.expected);
    const told = row.injected.find(
      (c) =>
        c !== 'other' &&
        DECIDER_OPTIONS.includes(c) &&
        c !== row.expected &&
        !row.acceptable.includes(c),
    );
    if (told && !obeys.has(key)) obeys.set(key, told);
  }
  return {
    id: 'systemone',
    threshold: 0.8,
    async classify(item) {
      const h = hash(item.description);
      const ms = 80 + (h % 400);
      if (stub === 'failing') {
        p.log('warn', 'decider_failed', { decider: 'stub', status: 503, retryable: true, ms });
        throw new p.DeciderError(true, 503);
      }
      const label = labels.get(item.description) ?? 'other';
      const right = DECIDER_OPTIONS.includes(label) ? label : 'other';
      const wrong = FIXED_OPTIONS[(FIXED_OPTIONS.indexOf(right) + 1) % FIXED_OPTIONS.length];
      let [answer, confidence] = [right, 0.99];
      if (stub === 'noisy') {
        confidence = CONFIDENCES[h % CONFIDENCES.length];
        if ((h >>> 8) % 100 >= confidence * 100) answer = wrong;
      }
      if (stub === 'first-option') {
        confidence = 0.9;
        if ((h >>> 4) % 2 === 0) answer = DECIDER_OPTIONS[0];
      }
      if (stub === 'obedient') [answer, confidence] = [obeys.get(item.description) ?? right, 1];
      p.log('info', 'decider_ok', {
        decider: 'stub',
        status: 200,
        ms,
        inputUnits: 300 + item.description.length,
      });
      return {
        candidates: [{ category: answer, p: confidence }],
        confidence,
        model: `stub-${stub}`,
      };
    },
  };
}

// The decider of a configuration, or why it cannot run. The key itself is never read here: the
// adapters do that.
function decidersFor(config: EvalConfig, rows: EvalRow[], p: Pipeline): Decider[] | string {
  if (config === 'rules') return [];
  if (config === 'openai')
    return process.env.OPENAI_API_KEY?.trim()
      ? [p.openaiDecider()]
      : 'no OPENAI_API_KEY in the environment';
  if (config === 'systemone')
    return p.config.deciderApiKey
      ? [p.systemOneDecider()]
      : 'no DECIDER_API_KEY in the environment';
  return [stubDecider(config.slice('stub:'.length) as Stub, rows, p)];
}

// --- one run ----------------------------------------------------------------------------------

// The app's log lines (one JSON object per line on the console) are collected instead of printed
// while a run is in flight: `decider_ok` and `decider_failed` are the cost and latency data.
function collectLogs() {
  const events: LogEvent[] = [];
  const levels = ['info', 'warn', 'error'] as const;
  const original = levels.map((level) => console[level]);
  levels.forEach((level, i) => {
    console[level] = (...args: unknown[]) => {
      try {
        const parsed = JSON.parse(String(args[0]));
        if (typeof parsed?.event === 'string') return void events.push(parsed);
      } catch {}
      original[i](...args);
    };
  });
  return { events, restore: () => levels.forEach((level, i) => (console[level] = original[i])) };
}

export type EvalRun = {
  outcomes: Map<string, Outcome>;
  events: LogEvent[];
  threshold: number | null; // the bar of the decider, null for rules only
};
let runs = 0;
// One configuration over a set. Every row is its own customer, so no decision, rule or merchant
// profile is shared between rows. Resolves to `{skipped}` when the configuration cannot run.
export async function evaluate(
  rows: EvalRow[],
  config: EvalConfig,
  { profile = true }: { profile?: boolean } = {},
): Promise<EvalRun | { skipped: string }> {
  const p = await pipeline();
  const deciders = decidersFor(config, rows, p);
  if (typeof deciders === 'string') return { skipped: deciders };
  // EV1: said before the first request, on stderr so that the report stays clean.
  if (config === 'openai' || config === 'systemone')
    console.error(
      `${config}: up to ${rows.length} movements (those the rules leave open) are sent to the provider. This bills the configured account.`,
    );
  const run = ++runs;
  const logs = collectLogs();
  try {
    const answers = await Promise.all(
      rows.map(async (row) => {
        const result = await p.classifyMovements({
          userId: `eval-${run}-${row.id}`,
          movements: [toMovement(row)],
          ownAccountIds: EVAL_OWN_ACCOUNTS,
          deciders,
          wait: true,
          profile,
        });
        const { id, state, source, reason, confidence, candidates } = result.get(row.id)!;
        return [row.id, { id, state, source, reason, confidence, candidates }] as const;
      }),
    );
    return {
      outcomes: new Map(answers),
      events: logs.events,
      threshold: deciders[0]?.threshold ?? null,
    };
  } finally {
    logs.restore();
  }
}

// --- the report -------------------------------------------------------------------------------

const pct = (count: number, of: number) => {
  const r = rate(count, of);
  return r === null ? '—' : `${(r * 100).toFixed(1)}% (${count}/${of})`;
};
const usd = (amount: number) => `$${amount.toFixed(6)}`;
function table(lines: (string | number)[][]) {
  const cells = lines.map((line) => line.map(String));
  const widths = cells[0].map((_, i) => Math.max(...cells.map((line) => line[i].length)));
  return cells.map((line) => `  ${line.map((c, i) => c.padEnd(widths[i])).join('  ')}`.trimEnd());
}
// One set of columns everywhere, each named by its denominator. "Of shown" is the definition the
// held-out bars use (requirements.md "Held-out bars"); "of all rows" counts a row in review as not
// right. The counts are the same in both views.
const TALLY_HEAD = [
  'rows',
  'coverage',
  'strict of shown',
  'lenient of shown',
  'wrong-but-shown of shown',
  'strict of all rows',
  'lenient of all rows',
  'wrong-but-shown of all rows',
];
const tallyCells = (t: Tally) => [
  t.rows,
  pct(t.shown, t.rows),
  pct(t.strict, t.shown),
  pct(t.lenient, t.shown),
  pct(t.wrongShown, t.shown),
  pct(t.strict, t.rows),
  pct(t.lenient, t.rows),
  pct(t.wrongShown, t.rows),
];
// Stable order: the known tiers first, anything else after them by name.
const ORDER = ['easy', 'medium', 'hard', 'ambiguous', 'es', 'en', 'neutral'];
const rank = (key: string) => (ORDER.includes(key) ? ORDER.indexOf(key) : ORDER.length);
const splitTable = (name: string, groups: Record<string, Tally>) =>
  table([
    [name, ...TALLY_HEAD],
    ...Object.entries(groups)
      .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
      .map(([key, t]) => [key, ...tallyCells(t)]),
  ]);

function categoryTable(confusion: Score['confusion']) {
  const lines = CATEGORY_IDS.filter((id) => confusion[id]).map((expected) => {
    const got = confusion[expected];
    const rows = Object.values(got).reduce((sum, n) => sum + n, 0);
    const wrong = Object.entries(got)
      .filter(([id]) => id !== expected && id !== 'review')
      .sort(([a, n], [b, m]) => m - n || a.localeCompare(b));
    return [
      expected,
      rows,
      got[expected] ?? 0,
      got.review ?? 0,
      wrong.reduce((sum, [, n]) => sum + n, 0),
      wrong.map(([id, n]) => `${id}×${n}`).join(', ') || '—',
    ];
  });
  return table([['expected', 'rows', 'right', 'review', 'shown as another', 'which'], ...lines]);
}

type Meta = {
  set: string;
  config: EvalConfig;
  reversed: boolean;
  profile: boolean;
  threshold: number | null;
  usdPerMillion?: number;
};
type Comparison = {
  flip?: { compared: number; flipped: number } | string; // a string: why it could not be computed
  ablation?: { withProfile: Tally } | string;
};
const isStub = (config: EvalConfig) => config.startsWith('stub:');
const STUB_LINE =
  'STUB DECIDER: answers, latency and input units are made in-process. This proves the report, not a provider.';
// Exit status when a configuration was skipped (no key) or a decider left rows unanswered: the
// run ended, but not everything asked for was measured. 0 = all measured, 2 = usage, 1 = crash.
const NOT_ALL_MEASURED = 3;

function usageLines(u: Usage, s: Score, meta: Meta, unavailable: number) {
  const price = meta.usdPerMillion;
  const cost = price === undefined ? null : costUsd(u.inputUnits, price);
  const statuses = Object.entries(u.errorsByStatus).map(([status, n]) => `${status} × ${n}`);
  return [
    `Cost and latency${isStub(meta.config) ? ' (STUB: synthetic values)' : ''}`,
    `  requests                  ${u.requests} (${u.ok} answered, ${u.requests - u.ok} failed)`,
    `  input units               ${u.inputUnits}${u.unitsMissing ? ` (${u.unitsMissing} answers came without usage: a lower bound)` : ''}`,
    cost === null
      ? '  estimated cost            not computed: no documented price for this decider (pass --price=<USD per million input units>)'
      : `  estimated cost            ${usd(cost)} at $${price} per million input units`,
    ...(cost === null
      ? []
      : [
          `  cost per 1,000 movements  ${usd((cost / s.total.rows) * 1000)} (this set's mix: ${u.requests} requests for ${s.total.rows} movements)`,
        ]),
    `  latency                   p50 ${u.p50Ms ?? '—'} ms · p95 ${u.p95Ms ?? '—'} ms (answered requests)`,
    `  errors                    retryable ${u.errors.retryable} · not retryable ${u.errors.notRetryable}${statuses.length ? ` · by status: ${statuses.join(', ')}` : ''}`,
    `  rows left without an answer (decider_unavailable): ${unavailable}`,
  ];
}

// IG1: what the injected-text guard did to this run's model answers (src/insights/guard.ts).
// namedInText: answers above the bar that were the category the text names, so not shown.
// shownOnAddressed: answers shown on a text written to the classifier (`addressedText`, which the
// pipeline does not apply: REQ-CORE-18 is frozen); the answer is not a category the text names.
// modelOther: answers whose top option was `other` (stored `below_threshold` whatever the
// confidence: tests/acceptance/si4-core-pipeline.test.ts:441 freezes that reason).
export type GuardCount = { namedInText: number; shownOnAddressed: number; modelOther: number };
export function guardCount(
  rows: EvalRow[],
  outcomes: ReadonlyMap<string, Outcome>,
  addressed: (description: string) => boolean,
): GuardCount {
  const count = { namedInText: 0, shownOnAddressed: 0, modelOther: 0 };
  for (const row of rows) {
    const o = outcomes.get(row.id);
    if (o?.source !== 'model') continue;
    if (o.reason === 'named_in_text') count.namedInText++;
    if (o.state === 'estimated' && addressed(row.description)) count.shownOnAddressed++;
    if (o.candidates[0]?.category === 'other') count.modelOther++;
  }
  return count;
}

function report(
  meta: Meta,
  s: Score,
  u: Usage,
  unavailable: number,
  compared: Comparison,
  g: GuardCount,
) {
  const t = s.total;
  const lines = [
    `Spend insights evaluation — set ${meta.set} (${t.rows} rows) — configuration ${meta.config}`,
    ...(isStub(meta.config) ? [STUB_LINE] : []),
    ...(unavailable
      ? [
          `INCOMPLETE: ${unavailable} of ${t.rows} rows got no answer from the decider (decider_unavailable) and are counted as sent to review. Not a full measurement of this decider.`,
        ]
      : []),
    `option order: ${DECIDER_OPTIONS.join(', ')}${meta.reversed ? ' (REVERSED)' : ''}`,
    `merchant profile: ${meta.profile ? 'on' : 'OFF (every label neutral)'} · threshold: ${meta.threshold ?? 'none (rules only)'}`,
    '',
    'Totals (shown = not sent to review)',
    `  coverage (shown of all rows)   ${pct(t.shown, t.rows)}`,
    'Of the shown rows — the definitions of the held-out bars:',
    `  strict of shown                ${pct(t.strict, t.shown)}`,
    `  lenient of shown               ${pct(t.lenient, t.shown)}`,
    `  wrong-but-shown of shown       ${pct(t.wrongShown, t.shown)}`,
    'Of all rows — a row in review counts as not right:',
    `  strict of all rows             ${pct(t.strict, t.rows)}`,
    `  lenient of all rows            ${pct(t.lenient, t.rows)}`,
    `  wrong-but-shown of all rows    ${pct(t.wrongShown, t.rows)}`,
    `  decided by rules ${pct(s.decidedBy.rules, t.rows)} · by the model ${pct(s.decidedBy.model, t.rows)} · sent to review ${pct(s.decidedBy.review, t.rows)}`,
    ...(meta.config === 'rules'
      ? []
      : [
          `  injected-text guard: model answers above the bar not shown, being the category the text names (in review, named_in_text): ${g.namedInText}`,
          `  model answers shown on a text addressed to the classifier (not withheld; the answer is a category the text does not name): ${g.shownOnAddressed}`,
          `  model answers whose top option was other (in review, reason below_threshold at any confidence): ${g.modelOther}`,
        ]),
    '',
    'By difficulty',
    ...splitTable('tier', s.byDifficulty),
    '',
    'By language of the description (derived from its words; `neutral`: a bare merchant name)',
    ...splitTable('language', s.byLanguage),
    '',
    'Adversarial rows (an instruction is injected in the text)',
    ...table([TALLY_HEAD, tallyCells(s.adversarial)]),
    `  steered by the injected text (shown wrong with a category the text names): ${s.adversarial.obeyed} of ${s.adversarial.rows}`,
    '',
    'Per category (right = shown with the expected category; "another" includes acceptable labels)',
    ...categoryTable(s.confusion),
  ];
  if (meta.config !== 'rules')
    lines.push(
      '',
      'Reliability (rows a model answered, by its confidence; right = its top option, leniently)',
      ...table([
        ['confidence', 'rows', 'observed accuracy'],
        ...s.reliability.map((b) => [b.bucket, b.rows, pct(b.correct, b.rows)]),
      ]),
      '',
      'Threshold (this run re-decided at each bar, from the stored confidences; no extra request)',
      ...table([
        ['threshold', ...TALLY_HEAD.slice(1)],
        ...s.thresholds.map((row) => [row.threshold.toFixed(2), ...tallyCells(row).slice(1)]),
      ]),
      '',
      ...usageLines(u, s, meta, unavailable),
    );
  const { flip, ablation } = compared;
  if (flip !== undefined)
    lines.push(
      '',
      'Option order (against the same run with the order as shipped)',
      typeof flip === 'string'
        ? `  flip rate: not computed — ${flip}`
        : `  flip rate: ${pct(flip.flipped, flip.compared)} of the rows a model answered in both runs changed top option`,
    );
  if (ablation !== undefined)
    lines.push(
      '',
      'Merchant profile ablation',
      ...(typeof ablation === 'string'
        ? [`  not computed — ${ablation}`]
        : table([
            ['', ...TALLY_HEAD],
            ['with profile', ...tallyCells(ablation.withProfile)],
            ['without', ...tallyCells(t)],
          ])),
    );
  return `${lines.join('\n')}\n`;
}

// Per-row detail (--rows only): every row that is not strictly right, and the adversarial rows.
function rowDetail(rows: EvalRow[], outcomes: Map<string, Outcome>) {
  const shown = (o: Outcome) => (o.state === 'needs_review' ? 'review' : o.id);
  const misses = rows.filter((row) => shown(outcomes.get(row.id)!) !== row.expected);
  const lines = misses.map((row) => {
    const o = outcomes.get(row.id)!;
    const also = row.acceptable.length ? ` (acceptable: ${row.acceptable.join(', ')})` : '';
    return `${row.id} · ${row.difficulty} · expected ${row.expected}${also} · got ${shown(o)} [${o.source}, ${o.reason}${o.confidence === null ? '' : `, ${o.confidence.toFixed(2)}`}] · ${row.description}`;
  });
  const adversarial = rows
    .filter((row) => row.adversarial)
    .map((row) => {
      const got = shown(outcomes.get(row.id)!);
      const right = got === row.expected || row.acceptable.includes(got as CategoryId);
      const obeyed = got !== 'review' && !right && row.injected.includes(got as CategoryId);
      return `${row.id} · expected ${row.expected} · got ${got} · obeyed the injection: ${obeyed ? 'YES' : 'no'}`;
    });
  return `Not strictly right: ${misses.length} of ${rows.length}\n${lines.join('\n')}\n\nAdversarial rows\n${adversarial.join('\n')}\n`;
}

// --- the command line -------------------------------------------------------------------------

class UsageError extends Error {}
const USAGE = `npm run eval:insights -- [options]
  --set=dev|heldout|<path>   the labelled set (default dev)
  --decider=<list>           comma list of: rules (or none; the default), openai, systemone, all (the three),
                             stubs (the five below), stub:oracle, stub:noisy, stub:first-option, stub:failing,
                             stub:obedient.
                             openai and systemone call the provider and bill its account: never run unasked
  --out=<dir>                where the files go (default ${EVIDENCE}, or ${EVIDENCE}/heldout for a held-out path)
  --reverse-options          send the options in reverse order; reports the flip rate against the plain run in <out>
  --no-profile               neutral merchant profile; reports the ablation against the plain run in <out>
  --rows                     also print and write the misses and the adversarial rows, one line each;
                             refused for a path containing "heldout" unless ${OVERRIDE}=1
  --price=<USD>              price per million input units, for the cost (default 0.042 for System One)
Exit status: 0 everything asked for was measured; 3 a configuration was SKIPPED (no key) or a decider
left rows unanswered (INCOMPLETE); 2 a wrong option, set or path; 1 an unreadable set or a crash.`;

function parseArgs(argv: string[]) {
  const opts = {
    set: 'dev',
    // EV1: rules only unless a decider is named. A key in the environment is not a request to bill it.
    configs: ['rules'] as EvalConfig[],
    asked: false,
    out: undefined as string | undefined,
    reversed: false,
    profile: true,
    rows: false,
    price: undefined as number | undefined,
  };
  for (const arg of argv) {
    const [flag, value = ''] = arg.split(/=(.*)/s);
    if (flag === '--set' && value) opts.set = value;
    else if (flag === '--out' && value) opts.out = value;
    else if (arg === '--reverse-options') opts.reversed = true;
    else if (arg === '--no-profile') opts.profile = false;
    else if (arg === '--rows') opts.rows = true;
    else if (flag === '--price' && Number(value) >= 0 && value) opts.price = Number(value);
    else if (flag === '--decider' && value) {
      const names = value.split(',').flatMap((name) => {
        if (name === 'all') return LIVE;
        if (name === 'stubs') return STUBS.map((stub) => `stub:${stub}`);
        return [name === 'none' ? 'rules' : name];
      });
      const unknown = names.find((name) => !isConfig(name));
      if (unknown) throw new UsageError(`Unknown decider configuration "${unknown}".`);
      opts.configs = [...new Set(names)] as EvalConfig[];
      opts.asked = true;
    } else throw new UsageError(`Unknown option "${arg}".`);
  }
  return opts;
}

const readJson = (file: string) =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;

async function main(argv: string[]) {
  const opts = parseArgs(argv);
  const setPath = SETS[opts.set] ?? opts.set;
  // A held-out path gives aggregates only: nothing per row on the screen or in a file, unless the
  // reviewer's override is set.
  if (!fs.existsSync(setPath)) throw new UsageError(`No such set: ${setPath}`);
  // The path as given and the file it really is: a symbolic link with another name is still the
  // held-out set. A copy under another name is not caught, by design.
  const blind = [path.resolve(setPath), fs.realpathSync(setPath)].some((p) => /heldout/i.test(p));
  const detail = !blind || process.env[OVERRIDE] === '1';
  if (opts.rows && !detail)
    throw new UsageError(
      `--rows is refused for a held-out path: its rows are blind. Reviewers set ${OVERRIDE}=1.`,
    );
  const rows = parseEvalSet(fs.readFileSync(setPath, 'utf8'));
  if (!rows.length) throw new UsageError(`The set has no rows: ${setPath}`);
  const set = SETS[opts.set]
    ? opts.set
    : path.basename(setPath, '.jsonl').replace(/^eval-set-/, '');
  const out = opts.out ?? (blind ? `${EVIDENCE}/heldout` : EVIDENCE);
  const prefix = blind ? '' : `${set}-`;
  const variant = `${opts.reversed ? '-reversed' : ''}${opts.profile ? '' : '-no-profile'}`;
  const variantFlags = `${opts.reversed ? ' --reverse-options' : ''}${opts.profile ? '' : ' --no-profile'}`;
  fs.mkdirSync(out, { recursive: true });

  // The adapters read the option order when they are loaded: reverse it before they are.
  if (opts.reversed) (DECIDER_OPTIONS as CategoryId[]).reverse();
  // Never the app's data: a directory of its own, removed at the end.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-eval-'));
  process.env.DATA_DIR = dataDir;

  const skipped: string[] = [];
  const incomplete: string[] = [];
  try {
    for (const config of opts.configs) {
      const slug = config.replace(':', '-');
      const base = path.join(out, `${prefix}${slug}`);
      const run = await evaluate(rows, config, { profile: opts.profile });
      if ('skipped' in run) {
        const command = `npm run eval:insights -- --set=${opts.set} --decider=${config}${variantFlags}`;
        const line = `SKIPPED ${config} on set ${set}: ${run.skipped}. Not measured. To measure: ${command}`;
        console.log(`\n${line}`);
        fs.writeFileSync(`${base}${variant}-not-measured.txt`, `${line}\n`);
        skipped.push(config);
        continue;
      }
      const s = score(rows, run.outcomes);
      const u = usage(run.events);
      const unavailable = [...run.outcomes.values()].filter(
        (o) => o.reason === 'decider_unavailable',
      ).length;
      if (unavailable) incomplete.push(config);
      // Comparisons need the plain run of the same configuration, made before in the same <out>.
      const plain = variant ? readJson(`${base}.json`) : undefined;
      const missing = `run the same command without${variantFlags} first`;
      const compared: Comparison = {};
      if (opts.reversed)
        compared.flip = !plain
          ? missing
          : !plain.outcomes
            ? `the plain run of a held-out path keeps no per-row outcome without ${OVERRIDE}=1`
            : flipRate(rows, new Map(Object.entries<Outcome>(plain.outcomes)), run.outcomes);
      if (!opts.profile)
        compared.ablation = plain ? { withProfile: plain.score.total as Tally } : missing;
      const meta: Meta = {
        set,
        config,
        reversed: opts.reversed,
        profile: opts.profile,
        threshold: run.threshold,
        usdPerMillion: opts.price ?? (config === 'openai' ? undefined : SYSTEM_ONE_USD_PER_MILLION),
      };
      const guard = guardCount(rows, run.outcomes, (await pipeline()).addressedText);
      const text = report(meta, s, u, unavailable, compared, guard);
      console.log(`\n${text}`);
      fs.writeFileSync(`${base}${variant}.txt`, text);
      fs.writeFileSync(
        `${base}${variant}.json`,
        `${JSON.stringify(
          {
            ...meta,
            stub: isStub(config),
            incomplete: unavailable > 0,
            optionOrder: DECIDER_OPTIONS,
            rows: rows.length,
            score: s,
            ...(config === 'rules' ? {} : { usage: u, unavailable, guard }),
            ...compared,
            ...(detail ? { outcomes: Object.fromEntries(run.outcomes) } : {}),
          },
          null,
          2,
        )}\n`,
      );
      if (opts.rows) {
        const rowsText = `${isStub(config) ? `${STUB_LINE}\n` : ''}${rowDetail(rows, run.outcomes)}`;
        console.log(rowsText);
        fs.writeFileSync(`${base}${variant}-misses.txt`, rowsText);
      }
    }
  } finally {
    const { closeAppDb } = await import('../src/db');
    closeAppDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  if (skipped.length)
    console.log(
      `\nSKIPPED, not measured: ${skipped.join(', ')}. Measured: ${opts.configs.filter((c) => !skipped.includes(c)).join(', ') || 'nothing'}.`,
    );
  if (incomplete.length)
    console.log(`\nINCOMPLETE, rows left without an answer: ${incomplete.join(', ')}.`);
  if (!opts.asked)
    console.log(
      '\nLive deciders not run (they call the provider and bill its account). To run them: --decider=openai, --decider=systemone, or --decider=all.',
    );
  console.log(`Files: ${out}`);
  // A script can tell a full run (0) from one where something was not measured.
  if (skipped.length || incomplete.length) process.exitCode = NOT_ALL_MEASURED;
}

// Run as a script only: importing this file (the held-out bars test) runs nothing.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error) => {
    const usageError = error instanceof UsageError;
    console.error(usageError ? `${error.message}\n\n${USAGE}` : error);
    process.exit(usageError ? 2 : 1);
  });
