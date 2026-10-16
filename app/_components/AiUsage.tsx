// TR2 (plan 27 §6, REQ-TR-10/11): the operator's "AI usage" tab. Everything shown is a figure of
// GET /api/usage (TR1): counts, tokens, nano-dollars, ids, times and tool names. The API returns
// no prompt, message, title or movement text, and this view shows none.
import { useEffect, useRef, useState } from 'react';
import type { Totals } from '../../src/usage/report';
import { formatDate, type AnyRecord } from '../../src/ui-helpers';
import { Icon } from './Icon';
import { UsageSankey } from './UsageSankey';

type Api = (path: string) => Promise<AnyRecord>;
type Period = 'today' | '7d' | '30d' | 'all' | 'range';
// UP1: `30d` and `range` (with `from`/`to`), served by GET /api/usage since #194.
const PERIODS: [Period, string][] = [
  ['today', 'Today'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
  ['all', 'All'],
];
type Applied = { period: Period; from?: string; to?: string };
export const usageQuery = (a: Applied) =>
  a.period === 'range' ? `period=range&from=${a.from}&to=${a.to}` : `period=${a.period}`;

// Days are Europe/Madrid calendar days, as the server counts them.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const madridDay = (at: string | number | Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(at));
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const dayWords = (day: string, year = true) =>
  `${Number(day.slice(8))} ${MONTHS[Number(day.slice(5, 7)) - 1]}${year ? ` ${day.slice(0, 4)}` : ''}`;
// "7 Oct 2026", "1–7 Oct 2026", "28 Sep – 4 Oct 2026", "29 Dec 2025 – 4 Jan 2026".
export function daysText(from: string, to: string) {
  if (from === to) return dayWords(from);
  if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8))}–${dayWords(to)}`;
  return `${dayWords(from, from.slice(0, 4) !== to.slice(0, 4))} – ${dayWords(to)}`;
}
// The selected period in words, from the answer's `since`/`until`/`from`/`to` (never the
// browser's clock). An open end (`until` null) is the period's last day counted from `since`.
export function periodWords(data: AnyRecord) {
  const start = data.since ? madridDay(data.since) : null;
  const span = ({ today: 0, '7d': 6, '30d': 29 } as Record<string, number>)[data.period] ?? 0;
  const end = data.until ? addDays(madridDay(data.until), -1) : start && addDays(start, span);
  if (data.period === 'range' && (data.from ?? start) && (data.to ?? end))
    return daysText(data.from ?? start, data.to ?? end);
  if (start && end) {
    if (data.period === 'today') return `Today, ${dayWords(start)}`;
    if (data.period === '7d') return `Last 7 days (${daysText(start, end)})`;
    if (data.period === '30d') return `Last 30 days (${daysText(start, end)})`;
  }
  // `all` has no `since`: the words use the first recorded request.
  return data.firstRecordAt ? `All, since ${dayWords(madridDay(data.firstRecordAt))}` : 'All';
}
// A custom range: both days, From ≤ To, none after today (Madrid). Null while incomplete or valid.
export function rangeHint(from: string, to: string, today: string) {
  if ([from, to].some((d) => d && d > today)) return `Choose dates up to ${dayWords(today)}.`;
  if (from && to && from > to) return 'From must be on or before To.';
  return null;
}
export const rangeReady = (from: string, to: string, today: string) =>
  !!from && !!to && !rangeHint(from, to, today);
const CONSUMERS: Record<string, string> = {
  assistant: 'Assistant (chat)',
  voice: 'Voice (transcription)',
  operator_preview: 'Operator preview',
  'decider:systemone': 'System One decider (Jev)',
  'decider:openai': 'OpenAI decider',
  embeddings: 'Embeddings (document search)',
};
export const consumerLabel = (consumer: string) => CONSUMERS[consumer] ?? consumer;

const grouped = new Intl.NumberFormat('en');
// A token or request count with thousands separators; "—" when the provider reported none.
export const count = (n: number | null | undefined) => (n == null ? '—' : grouped.format(n));
const plural = (n: number, word: string) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;

// Whole nano-dollars as US$. Two decimals from $1, four from a cent, six below it and all nine
// under ten micro-dollars, so a real cost never reads "$0.0000". Never scientific notation.
const decimals = (nano: number) =>
  nano === 0 || nano >= 1e9 ? 2 : nano >= 1e7 ? 4 : nano >= 1e4 ? 6 : 9;
export function usd(nano: number) {
  // UI3: the step is chosen after rounding, so 9,999,999 reads $0.0100 and not $0.010000.
  const step = 10 ** (9 - decimals(nano));
  const digits = decimals(Math.round(nano / step) * step);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(nano / 1e9);
}

type CostTotals = Pick<Totals, 'requests' | 'costNanoUsd' | 'providerNanoUsd' | 'unpricedRequests'>;
// The one wording of a group's cost. No requests: "—". Requests and no price: "Not priced",
// never $0. Otherwise the amount with its basis: an estimate unless the provider reported all.
export function costOf(t: CostTotals): { text: string; note: string } {
  if (t.requests === 0) return { text: '—', note: '' };
  if (t.costNanoUsd === null) return { text: 'Not priced', note: '' };
  const text = usd(t.costNanoUsd);
  if (t.unpricedRequests > 0)
    return { text, note: `estimated · partly priced, ${count(t.unpricedRequests)} not priced` };
  if (t.costNanoUsd > 0 && t.providerNanoUsd === t.costNanoUsd)
    return { text, note: 'reported by the provider' };
  return { text, note: 'estimated' };
}
// One model request: its own cost and basis.
export function requestCost(r: AnyRecord) {
  if (r.costBasis === 'unpriced' || r.costNanoUsd == null) return 'Not priced';
  return `${usd(r.costNanoUsd)} ${r.costBasis === 'provider' ? 'reported by the provider' : 'estimated'}`;
}
// The case detail's line under an assistant turn; null when the run has no recorded usage.
export function runUsageLine(usage: Totals | null | undefined) {
  if (!usage || usage.requests === 0) return null;
  const { text, note } = costOf(usage);
  const cost =
    usage.costNanoUsd === null
      ? text
      : note === 'reported by the provider'
        ? `${text} ${note}`
        : `est. ${text}${usage.unpricedRequests > 0 ? ' (partly priced)' : ''}`;
  return `${plural(usage.requests, 'request')} · ${count(usage.inputTokens)} in / ${count(usage.outputTokens)} out tokens · ${cost}`;
}

// Under a column headed "Estimated cost" the plain word is not repeated; elsewhere (`full`) it is.
function Cost({ t, full = false }: { t: CostTotals; full?: boolean }) {
  const { text, note } = costOf(t);
  return (
    <span className="usage-cost">
      {text}
      {note && (full || note !== 'estimated') && <small>{note}</small>}
    </span>
  );
}
const TOKEN_HEADS = ['Requests', 'Input', 'Cached', 'Output', 'Estimated cost'];
function Heads({ first, share = false }: { first: string; share?: boolean }) {
  return (
    <thead>
      <tr>
        <th scope="col">{first}</th>
        {TOKEN_HEADS.map((h) => (
          <th scope="col" key={h}>
            {h}
          </th>
        ))}
        {share && <th scope="col">Share of cost</th>}
      </tr>
    </thead>
  );
}
function Figures({ t }: { t: Totals }) {
  return (
    <>
      <td>
        {count(t.requests)}
        {t.failed > 0 && <small>{count(t.failed)} failed</small>}
      </td>
      <td>{count(t.inputTokens)}</td>
      <td>{count(t.cachedInputTokens)}</td>
      <td>{count(t.outputTokens)}</td>
      <td>
        <Cost t={t} />
      </td>
    </>
  );
}
function Tiles({ t }: { t: Totals }) {
  const cost = costOf(t);
  const tiles: [string, string, string?][] = [
    ['Estimated cost', cost.text, cost.note],
    ['Requests', count(t.requests), t.failed > 0 ? `${count(t.failed)} failed` : undefined],
    ['Input tokens', count(t.inputTokens)],
    ['Cached tokens', count(t.cachedInputTokens), 'part of the input'],
    ['Output tokens', count(t.outputTokens)],
    ['Reasoning tokens', count(t.reasoningTokens), 'part of the output'],
  ];
  return (
    <dl className="usage-tiles">
      {tiles.map(([label, value, note]) => (
        <div className="card" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
          {note && <dd className="usage-note">{note}</dd>}
        </div>
      ))}
    </dl>
  );
}
function Table({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // Wide tables scroll inside their card; focusable so the keyboard can scroll it too.
    <div className="usage-scroll" role="region" aria-label={label} tabIndex={0}>
      <table className="usage-table" aria-label={label}>
        {children}
      </table>
    </div>
  );
}

// UI3 (plan 28 §6.1, SC1): the daily limit per customer, from the overview's `cap`. Null when no
// limit is set or the server has no such field: nothing is shown. The reset time is the one
// `dayStart` (a UTC instant) reads in the bank's zone.
export const CAPPED = 'Daily limit reached · today';
export const CAPPED_TITLE =
  "Reached today's AI limit. The assistant answers without the model until the day resets.";
export function capLine(cap: AnyRecord | null | undefined) {
  if (!cap) return null;
  const reset = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(cap.dayStart));
  return `Daily limit per customer: ${usd(cap.dailyNanoUsd)} · ${count(cap.unpricedTokens)} tokens for requests with no price · resets at ${reset} Europe/Madrid`;
}
// "today": the mark means now, whichever period is selected. The clock and the words carry it,
// not the colour.
function CappedTag() {
  return (
    <span className="usage-tag capped" role="note" title={CAPPED_TITLE} aria-label={CAPPED_TITLE}>
      <Icon name="clock" size={12} />
      {CAPPED}
    </span>
  );
}

// The quiet line under the title, from the API's `prices[].source` only: the date each was read
// and the source's name (its text before the first bracket or comma). The whole strings are in
// "Prices used".
export function usageSourceLine(data: AnyRecord) {
  const sources: string[] = (data.prices ?? []).map((p: AnyRecord) => String(p.source));
  const distinct = (values: (string | undefined)[]) => [...new Set(values.filter(Boolean))];
  const dates = distinct(sources.map((s) => s.match(/\d{4}-\d{2}-\d{2}/)?.[0]));
  const names = distinct(sources.map((s) => s.split(/ \(|,/)[0].trim()));
  return `Estimated from token counts and list prices${dates.length ? ` read ${dates.join(', ')}` : ''}${names.length ? ` · ${names.join(', ')}` : ''}`;
}

export function UsageOverview({
  data,
  onCustomer,
}: {
  data: AnyRecord;
  onCustomer(c: { userId: string; name: string }): void;
}) {
  const totals: Totals = data.totals;
  if (totals.requests === 0)
    return (
      <section className="card usage-empty">
        <p>No AI usage recorded for this period.</p>
      </section>
    );
  return (
    <>
      <Tiles t={totals} />
      <UsageSankey data={data} periodName={periodWords(data)} />
      <section className="card usage-card">
        <h2>By customer</h2>
        {data.byCustomer.length === 0 ? (
          <p className="usage-note">No customer made a request in this period.</p>
        ) : (
          <Table label="AI usage by customer">
            <Heads first="Customer" share />
            <tbody>
              {data.byCustomer.map((c: AnyRecord) => (
                <tr key={c.userId}>
                  <th scope="row">
                    <button
                      type="button"
                      className="usage-open"
                      onClick={() => onCustomer({ userId: c.userId, name: c.name })}
                    >
                      <bdi>{c.name}</bdi>
                      <Icon name="arrow" size={12} />
                    </button>
                    {c.capped === true && <CappedTag />}
                  </th>
                  <Figures t={c as Totals} />
                  <td>
                    {c.sharePct == null ? (
                      <span aria-label="No priced cost">—</span>
                    ) : (
                      <span className="usage-share">
                        <i aria-hidden="true">
                          <b style={{ width: `${Math.min(100, c.sharePct)}%` }} />
                        </i>
                        {c.sharePct}%
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            {data.staffAndSystem.requests > 0 && (
              <tfoot>
                <tr>
                  <th scope="row">
                    Staff and system<small>outside the shares</small>
                  </th>
                  <Figures t={data.staffAndSystem} />
                  <td>—</td>
                </tr>
              </tfoot>
            )}
          </Table>
        )}
      </section>
      <section className="card usage-card">
        <h2>By consumer</h2>
        <Table label="AI usage by consumer">
          <Heads first="Consumer" />
          <tbody>
            {data.byConsumer.map((c: AnyRecord) => (
              <tr key={c.consumer}>
                <th scope="row">{consumerLabel(c.consumer)}</th>
                <Figures t={c as Totals} />
              </tr>
            ))}
          </tbody>
        </Table>
      </section>
      {data.byTool?.length > 0 && (
        <section className="card usage-card">
          <h2>Tools the assistant called</h2>
          <Table label="Tools the assistant called">
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col">Calls</th>
                <th scope="col">Turns</th>
              </tr>
            </thead>
            <tbody>
              {data.byTool.map((t: AnyRecord) => (
                <tr key={t.tool}>
                  <th scope="row">
                    <span className="usage-chip">{t.tool}</span>
                  </th>
                  <td>{count(t.calls)}</td>
                  <td>{count(t.runs)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="usage-note">
            Tokens are not split per tool: a tool&apos;s result is part of the next request&apos;s
            input.
          </p>
        </section>
      )}
      {data.prices?.length > 0 && (
        <details className="card usage-card usage-prices">
          <summary>Prices used</summary>
          <Table label="Prices used, US$ per million tokens">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Input</th>
                <th scope="col">Cached input</th>
                <th scope="col">Output</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {data.prices.map((p: AnyRecord) => (
                <tr key={p.model}>
                  <th scope="row">{p.model}</th>
                  {/* nano-dollars per token = US$ per billion; per million = value / 1000 */}
                  <td>${p.input / 1000}</td>
                  <td>{p.cached == null ? '—' : `$${p.cached / 1000}`}</td>
                  <td>${p.output / 1000}</td>
                  <td className="usage-source">{p.source}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="usage-note">
            US$ per million tokens. A merchant already classified for a customer and a text already
            embedded are not asked again: those reads cost nothing and have no row.
          </p>
        </details>
      )}
    </>
  );
}

// One line of figures under a drill-down row.
const figures = (t: Totals) =>
  `${plural(t.requests, 'request')} · ${count(t.inputTokens)} in (${count(t.cachedInputTokens)} cached) / ${count(t.outputTokens)} out tokens`;
function Summary({ t }: { t: Totals }) {
  return (
    <p className="usage-summary">
      <span>{figures(t)}</span>
      <Cost t={t} full />
    </p>
  );
}
const conversationName = (c: AnyRecord) => `Conversation · ${formatDate(c.startedAt)}`;
const turnName = (r: AnyRecord) => `Turn · ${formatDate(r.startedAt)}`;

// Drill-down level 1: one customer's conversations. No title: the API returns none.
export function CustomerLevel({
  data,
  onConversation,
  onOpenCase,
}: {
  data: AnyRecord;
  onConversation(id: string): void;
  onOpenCase(id: string): void;
}) {
  return (
    <>
      <Summary t={data.totals} />
      {data.totals.requests === 0 && (
        <p className="usage-note">No AI usage recorded for this period.</p>
      )}
      {data.byConsumer.length > 0 && (
        <ul className="usage-list" aria-label="By consumer">
          {data.byConsumer.map((c: AnyRecord) => (
            <li key={c.consumer}>
              <strong>{consumerLabel(c.consumer)}</strong>
              <Summary t={c as Totals} />
            </li>
          ))}
        </ul>
      )}
      <h3>Conversations</h3>
      {data.conversations.length === 0 && (
        <p className="usage-note">No request inside a conversation.</p>
      )}
      <ul className="usage-list">
        {data.conversations.map((c: AnyRecord) => (
          <li key={c.conversationId}>
            <button
              type="button"
              className="usage-open"
              onClick={() => onConversation(c.conversationId)}
            >
              {conversationName(c)}
              <Icon name="arrow" size={12} />
            </button>
            <p className="usage-meta">
              {plural(c.turns, 'turn')}
              {c.removed && <span className="usage-tag">Conversation removed</span>}
              {c.caseId && (
                <button type="button" className="usage-link" onClick={() => onOpenCase(c.caseId)}>
                  Open case
                </button>
              )}
            </p>
            <Summary t={c as Totals} />
          </li>
        ))}
      </ul>
      <h3>Outside the chat</h3>
      {data.outsideChat.requests === 0 ? (
        <p className="usage-note">No request outside a conversation.</p>
      ) : (
        <>
          <p className="usage-note">Overview, spending card and search.</p>
          <Summary t={data.outsideChat} />
        </>
      )}
    </>
  );
}

// Level 2: the turns (runs) of one conversation.
export function ConversationLevel({
  conversation,
  onRun,
}: {
  conversation: AnyRecord;
  onRun(id: string): void;
}) {
  return (
    <>
      <Summary t={conversation as Totals} />
      <h3>Turns</h3>
      <ul className="usage-list">
        {conversation.runs.map((r: AnyRecord) => (
          <li key={r.runId}>
            <button type="button" className="usage-open" onClick={() => onRun(r.runId)}>
              {turnName(r)}
              <Icon name="arrow" size={12} />
            </button>
            <p className="usage-meta">{r.status}</p>
            <Summary t={r as Totals} />
          </li>
        ))}
      </ul>
    </>
  );
}

// Level 3: every model request of one turn, in the order made.
export function RunLevel({ data }: { data: AnyRecord }) {
  return (
    <>
      <Summary t={data.totals} />
      <h3>Model requests</h3>
      {data.requests.length === 0 && <p className="usage-note">No request recorded.</p>}
      <ol className="usage-list usage-requests">
        {data.requests.map((r: AnyRecord) => (
          <li key={r.id} data-outcome={r.outcome}>
            <strong>
              {consumerLabel(r.consumer)}
              <span className={`usage-tag ${r.outcome === 'failed' ? 'failed' : ''}`}>
                {r.outcome}
              </span>
            </strong>
            <p className="usage-meta">
              <bdi>{r.model}</bdi> · request {r.seq}, attempt {r.attempt} ·{' '}
              {formatDate(r.createdAt)}
            </p>
            {r.inputTokens == null && r.outputTokens == null ? (
              <p className="usage-meta">Tokens not reported</p>
            ) : (
              <dl className="usage-tokens">
                {(
                  [
                    ['Input', r.inputTokens],
                    ['Cached', r.cachedInputTokens],
                    ['Output', r.outputTokens],
                    ['Reasoning', r.reasoningTokens],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd title={value == null ? 'Not reported by the provider' : undefined}>
                      {count(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {r.tools.length > 0 && (
              <p className="usage-chips" aria-label="Tools called">
                {r.tools.map((tool: string, i: number) => (
                  <span className="usage-chip" key={i}>
                    {tool}
                  </span>
                ))}
              </p>
            )}
            <p className="usage-request-cost">{requestCost(r)}</p>
          </li>
        ))}
      </ol>
    </>
  );
}

// A GET that keeps the last answer on screen while the next one loads (no layout jump) and drops
// an answer that arrives after the path changed.
function useUsage(api: Api, path: string | null) {
  const [state, setState] = useState<{ path: string | null; data?: AnyRecord; error?: string }>({
    path: null,
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    api(path).then(
      (data) => live && setState({ path, data }),
      // The last answer stays (`last`): a refused custom range keeps the figures shown before.
      (e: Error) => live && setState((s) => ({ path, error: e.message, data: s.data })),
    );
    return () => {
      live = false;
    };
  }, [api, path, attempt]);
  const settled = state.path === path;
  return {
    last: state.data,
    data: settled && !state.error ? state.data : undefined,
    error: settled ? state.error : undefined,
    loading: !!path && !settled,
    retry() {
      setState({ path: null });
      setAttempt((n) => n + 1);
    },
  };
}
function Failed({ what, message, onRetry }: { what: string; message: string; onRetry(): void }) {
  return (
    <section className="card load-error" role="alert">
      <h2>We could not load {what}</h2>
      <p>{message}</p>
      <button className="primary-button" type="button" onClick={onRetry}>
        Retry
      </button>
    </section>
  );
}
function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="usage-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}

export function AiUsage({ api, onOpenCase }: { api: Api; onOpenCase(id: string): void }) {
  const [applied, setApplied] = useState<Applied>({ period: '7d' });
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const today = madridDay(Date.now());
  const hint = rangeHint(from, to, today);
  const q = usageQuery(applied);
  const [customer, setCustomer] = useState<{ userId: string; name: string } | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const overview = useUsage(api, `usage?${q}`);
  const detail = useUsage(
    api,
    customer && `usage?${q}&customer=${encodeURIComponent(customer.userId)}`,
  );
  const run = useUsage(api, runId && `usage?run=${encodeURIComponent(runId)}`);
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  // Native <dialog>, as the account drawer: showModal() traps focus, Esc and the backdrop close
  // it, and focus returns to the row that opened it.
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (customer && !d.open) d.showModal();
    if (!customer && d.open) d.close();
  }, [customer]);
  // The button that moved a level is gone from the new one: put focus on the drawer's title.
  useEffect(() => {
    if (customer) title.current?.focus();
  }, [customer, conversationId, runId]);
  const close = () => {
    setCustomer(null);
    setConversationId(null);
    setRunId(null);
  };
  const shown = overview.data ?? overview.last;
  const conversation = detail.data?.conversations.find(
    (c: AnyRecord) => c.conversationId === conversationId,
  );
  const turn = conversation?.runs.find((r: AnyRecord) => r.runId === runId);
  const level = runId ? run : detail;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">CUSTOMER SUPPORT</div>
          <h1>AI usage</h1>
          <p className="usage-lines">
            {shown && <span className="usage-period">{periodWords(shown)}</span>}
            {shown && <span>{usageSourceLine(shown)}</span>}
            <span>
              The provider&apos;s invoice is the figure that counts. Days are the bank&apos;s local
              days, Europe/Madrid.
              {shown?.firstRecordAt && ` Recording started ${formatDate(shown.firstRecordAt)}.`}
              {shown && !shown.enabled && ' Usage recording is switched off (AI_USAGE=off).'}
            </span>
            {capLine(shown?.cap) && <span>{capLine(shown?.cap)}</span>}
          </p>
        </div>
        <div className="case-counters usage-actions">
          <div className="segmented" role="group" aria-label="Period">
            {PERIODS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={!custom && applied.period === id}
                onClick={() => {
                  setCustom(false);
                  setApplied({ period: id });
                }}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={custom || applied.period === 'range'}
              aria-expanded={custom}
              aria-controls="usage-range"
              onClick={() => {
                setCustom(true);
                setFrom(applied.from ?? from);
                setTo(applied.to ?? to);
              }}
            >
              Custom range
            </button>
          </div>
          <a className="secondary-button is-small" href={`/api/usage/export.csv?${q}`} download>
            Download CSV
          </a>
        </div>
      </div>
      {custom && (
        <form
          id="usage-range"
          className="usage-range"
          aria-label="Custom range"
          onSubmit={(e) => {
            e.preventDefault();
            if (rangeReady(from, to, today)) setApplied({ period: 'range', from, to });
          }}
        >
          <label>
            From
            <input
              type="date"
              value={from}
              max={to || today}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={to}
              min={from || undefined}
              max={today}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <button className="primary-button" type="submit" disabled={!rangeReady(from, to, today)}>
            Apply
          </button>
          {(hint || (applied.period === 'range' && overview.error)) && (
            <p className="usage-range-hint" role="alert">
              {hint ?? overview.error}
            </p>
          )}
        </form>
      )}
      {overview.error && !(applied.period === 'range' && custom) ? (
        <Failed what="AI usage" message={overview.error} onRetry={overview.retry} />
      ) : shown ? (
        <div className="usage-body" aria-busy={overview.loading} data-period={shown.period}>
          <UsageOverview data={shown} onCustomer={setCustomer} />
        </div>
      ) : (
        <div className="usage-body" aria-busy="true">
          <span className="sr-only" role="status">
            Loading AI usage…
          </span>
          <Skeleton rows={6} />
          <Skeleton rows={4} />
        </div>
      )}
      <dialog
        ref={dialog}
        className="usage-drawer"
        aria-labelledby="usage-drawer-title"
        onClose={close}
        onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}
      >
        {customer && (
          <>
            <div className="drawer-head">
              <h2 id="usage-drawer-title" ref={title} tabIndex={-1}>
                {turn
                  ? turnName(turn)
                  : conversation
                    ? conversationName(conversation)
                    : customer.name}
              </h2>
              <button
                type="button"
                className="icon-button close"
                aria-label="Close"
                onClick={() => dialog.current?.close()}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            {!conversationId &&
              shown?.byCustomer.some(
                (c: AnyRecord) => c.userId === customer.userId && c.capped === true,
              ) && (
                <p className="usage-drawer-mark">
                  <CappedTag />
                </p>
              )}
            {conversationId && (
              <nav className="usage-crumbs" aria-label="AI usage path">
                <ol>
                  <li>
                    {conversationId ? (
                      <button
                        type="button"
                        onClick={() => {
                          setConversationId(null);
                          setRunId(null);
                        }}
                      >
                        <bdi>{customer.name}</bdi>
                      </button>
                    ) : (
                      <bdi aria-current="page">{customer.name}</bdi>
                    )}
                  </li>
                  {conversation && (
                    <li>
                      {runId ? (
                        <button type="button" onClick={() => setRunId(null)}>
                          {conversationName(conversation)}
                        </button>
                      ) : (
                        <span aria-current="page">{conversationName(conversation)}</span>
                      )}
                    </li>
                  )}
                  {turn && (
                    <li>
                      <span aria-current="page">{turnName(turn)}</span>
                    </li>
                  )}
                </ol>
              </nav>
            )}
            <div className="usage-drawer-body" aria-busy={level.loading}>
              {level.error ? (
                <Failed what="this usage" message={level.error} onRetry={level.retry} />
              ) : !level.data ? (
                <>
                  <span className="sr-only" role="status">
                    Loading…
                  </span>
                  <Skeleton rows={4} />
                </>
              ) : runId ? (
                <RunLevel data={run.data!} />
              ) : conversation ? (
                <ConversationLevel conversation={conversation} onRun={setRunId} />
              ) : (
                <CustomerLevel
                  data={detail.data!}
                  onConversation={setConversationId}
                  onOpenCase={(id) => {
                    dialog.current?.close();
                    onOpenCase(id);
                  }}
                />
              )}
            </div>
          </>
        )}
      </dialog>
    </>
  );
}
