'use client';
// PT2 (plan 25 §6): prepared transfers in the page. A transfer left ready and sent later by the
// customer: when they say, on a date, or every month. Contract: "A sensitive operation must
// present its amount, source, and destination for explicit review before execution." Nothing here
// executes: Send asks the API for a proposal, and the existing "Transfers to confirm" card is the
// only place that confirms it (plan D3).
import { useEffect, useRef, useState } from 'react';
import type { PreparedView } from '../../src/banking/prepared';
import {
  accountName,
  formatDay,
  money,
  transferFeedback,
  type AnyRecord,
  stripBidi,
} from '../../src/ui-helpers';
import { Icon } from './Icon';

type Action = 'send' | 'skip' | 'pause' | 'resume' | 'delete';
type Message = { id: string; tone: 'info' | 'warning' | 'error'; text: string };
type WhenChoice = { when: 'manual' | 'on_date' | 'monthly'; date?: string; day?: number };

// Due dates are days in the app's zone (plan D9), whatever zone the browser is in.
export const madridDay = (at = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(at);
const addDays = (day: string, days: number) => {
  const d = new Date(day);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const hour = (at: string) =>
  new Intl.DateTimeFormat('en-IE', { hour: '2-digit', minute: '2-digit' }).format(new Date(at));
const monthName = (day: string) =>
  new Intl.DateTimeFormat('en-IE', { month: 'long', timeZone: 'UTC' }).format(new Date(day));

// The state of a prepared transfer in words (plan §2). Never colour only.
function preparedState(p: PreparedView, today = madridDay()): string {
  switch (p.state) {
    case 'verifying':
      return 'Sent · the bank has not confirmed it yet. Do not send it again.';
    case 'awaiting_confirmation':
      return `Waiting for your confirmation above · expires ${hour(p.expiresAt!)}`;
    case 'paused':
      return 'Paused · nothing becomes due until you resume';
    case 'due':
      return p.nextDue === today ? 'Due today' : `Due since ${formatDay(p.nextDue!)}`;
    case 'scheduled':
      return p.when.kind === 'monthly'
        ? `Next due ${formatDay(p.nextDue!)}`
        : `Due on ${formatDay(p.nextDue!)}`;
    case 'ready':
      return 'Ready when you are';
  }
}
const LAST_ATTEMPT = {
  expired: 'The last review expired without your confirmation. No money moved.',
  cancelled: 'You cancelled the last review. No money moved.',
  failed: 'The last attempt was not registered by the bank. No money moved.',
};
const what = (p: PreparedView) => `${money(p.amountCents)} to ${p.to}`;

function Card({
  p,
  dashboard,
  busy,
  message,
  onAct,
}: {
  p: PreparedView;
  dashboard: AnyRecord;
  busy: string;
  message: Message | null;
  onAct(p: PreparedView, action: Action): void;
}) {
  // Delete asks once, in the card. `kept` returns the focus to Delete after "Keep".
  const [asking, setAsking] = useState<'no' | 'yes' | 'kept'>('no');
  const monthly = p.when.kind === 'monthly',
    // With a review waiting or an outcome the bank has not confirmed, nothing can change (D6).
    locked = p.state === 'awaiting_confirmation' || p.state === 'verifying',
    running = (action: Action) => busy === `${action}:${p.id}`;
  function review() {
    const row = document.getElementById(`proposal-${p.approvalId}`);
    row?.scrollIntoView({ block: 'center' });
    row?.focus({ preventScroll: true });
  }
  return (
    <article
      id={`prepared-${p.id}`}
      className="prepared-card"
      data-testid="prepared-card"
      data-prepared-id={p.id}
      data-state={p.state}
      tabIndex={-1}
      aria-label={`Prepared transfer: ${what(p)}. ${preparedState(p)}`}
    >
      <p className="prepared-state" data-testid="prepared-state">
        <i aria-hidden="true" />
        {preparedState(p)}
      </p>
      <p className="prepared-title">
        <strong>{money(p.amountCents)}</strong> to <bdi>{p.to}</bdi>
      </p>
      <p className="prepared-meta">
        {/* FX3: customer and bank text is isolated from the app's words on the same line. */}
        From <bdi>{accountName(p.fromAccountId, dashboard)}</bdi> · <bdi>{p.concept}</bdi>
        {p.when.kind === 'monthly' && ` · every month on day ${p.when.day}`}
        {monthly && p.lastSentAt && ` · last sent ${formatDay(madridDay(new Date(p.lastSentAt)))}`}
      </p>
      {p.note && (
        <p className="prepared-note" data-testid="prepared-note">
          “<bdi>{p.note}</bdi>”
        </p>
      )}
      {p.lastAttempt && !locked && <p className="prepared-last">{LAST_ATTEMPT[p.lastAttempt]}</p>}
      {message && <p className={`prepared-feedback ${message.tone}`}>{message.text}</p>}
      {p.state === 'awaiting_confirmation' && (
        <div className="prepared-actions">
          <button
            type="button"
            className="text-link"
            data-testid="prepared-review"
            onClick={review}
          >
            Review above
          </button>
        </div>
      )}
      {!locked && asking !== 'yes' && (
        <div className="prepared-actions">
          {p.state !== 'paused' && (
            <button
              type="button"
              className="primary-button"
              data-testid="prepared-send"
              disabled={!!busy}
              onClick={() => onAct(p, 'send')}
            >
              <Icon name="check" size={16} />
              {running('send')
                ? 'Preparing review…'
                : p.state === 'scheduled'
                  ? 'Send now'
                  : 'Send'}
            </button>
          )}
          {monthly && p.state !== 'paused' && (
            <button
              type="button"
              className="secondary-button"
              data-testid="prepared-skip"
              disabled={!!busy}
              onClick={() => onAct(p, 'skip')}
            >
              <Icon name="close" size={16} />
              Skip {monthName(p.nextDue!)}
            </button>
          )}
          {monthly && (
            <button
              type="button"
              className="secondary-button"
              data-testid="prepared-pause"
              disabled={!!busy}
              onClick={() => onAct(p, p.state === 'paused' ? 'resume' : 'pause')}
            >
              {p.state === 'paused' ? 'Resume' : 'Pause'}
            </button>
          )}
          <button
            type="button"
            className="secondary-button"
            data-testid="prepared-delete"
            disabled={!!busy}
            autoFocus={asking === 'kept'}
            onClick={() => setAsking('yes')}
          >
            {!monthly && <Icon name="close" size={16} />}
            Delete
          </button>
        </div>
      )}
      {!locked && asking === 'yes' && (
        <div className="prepared-actions prepared-confirm" role="group" aria-label="Delete?">
          <span>Delete this prepared transfer? Nothing was sent.</span>
          <button
            type="button"
            className="secondary-button danger"
            data-testid="prepared-delete-confirm"
            disabled={!!busy}
            onClick={() => onAct(p, 'delete')}
          >
            {running('delete') ? 'Deleting…' : 'Delete'}
          </button>
          <button
            type="button"
            className="secondary-button"
            data-testid="prepared-delete-keep"
            disabled={!!busy}
            autoFocus
            onClick={() => setAsking('kept')}
          >
            Keep
          </button>
        </div>
      )}
    </article>
  );
}

// The block between "Transfers to confirm" and the form. With nothing prepared it is one line.
export function PreparedSection({
  items,
  dashboard,
  busy = '',
  message = null,
  focusId = '',
  onFocused,
  moveTo = null,
  onMoved,
  onAct,
  onLeave,
}: {
  items: PreparedView[];
  dashboard: AnyRecord;
  busy?: string;
  message?: Message | null;
  focusId?: string;
  onFocused?(): void;
  // A16 (polish): after a delete, the id of the card that followed the deleted one ('' if none).
  moveTo?: string | null;
  onMoved?(): void;
  onAct(p: PreparedView, action: Action): void;
  onLeave?(): void;
}) {
  const section = useRef<HTMLElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  // A16: the deleted card took the focus with it. It goes to the next card's first action, else
  // to the heading (to the section when no card is left), once the buttons are enabled again.
  useEffect(() => {
    if (moveTo === null || busy) return;
    const next =
      moveTo &&
      document
        .getElementById(`prepared-${moveTo}`)
        ?.querySelector<HTMLElement>('button:not(:disabled)');
    (next || heading.current || section.current)?.focus();
    onMoved?.();
  }, [moveTo, busy]);
  // A card just saved, or opened from Overview: bring it into view and move the focus to it.
  useEffect(() => {
    const card = focusId && document.getElementById(`prepared-${focusId}`);
    if (!card) return;
    card.scrollIntoView({ block: 'center' });
    card.focus({ preventScroll: true });
    onFocused?.();
  }, [focusId, items]);
  // The last result belongs to this visit of the screen.
  useEffect(() => onLeave, []);
  const due = items.filter((p) => p.state === 'due').length,
    // A result with no card left to show it on (a delete).
    loose = message && !items.some((p) => p.id === message.id);
  return (
    <section
      ref={section}
      tabIndex={-1}
      className={`card prepared${items.length ? '' : ' empty'}`}
      data-testid="prepared-section"
      aria-label="Prepared transfers"
    >
      {/* Always in the page, so a screen reader hears each result. */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="prepared-status">
        {message?.text}
      </p>
      {items.length > 0 && (
        <div className="prepared-head">
          <h2 ref={heading} tabIndex={-1}>
            <Icon name="clock" size={16} />
            Prepared transfers
            {due > 0 && (
              <span className="count-badge" data-testid="prepared-due-count">
                {due} due
              </span>
            )}
          </h2>
          <p>Ready to send when you decide. Nothing leaves your account until you confirm.</p>
        </div>
      )}
      {loose && <p className={`prepared-feedback ${message.tone}`}>{message.text}</p>}
      {items.length === 0 && (
        <p className="prepared-empty" data-testid="prepared-empty">
          <Icon name="clock" size={16} />
          <span>
            <strong>Not ready to send yet?</strong> Fill in a transfer below and choose “Prepare for
            later” to leave it waiting, for example the rent until you get the keys. Nothing is sent
            until you tap Send and confirm.
          </span>
        </p>
      )}
      {items.map((p) => (
        <Card
          key={p.id}
          p={p}
          dashboard={dashboard}
          busy={busy}
          message={message?.id === p.id ? message : null}
          onAct={onAct}
        />
      ))}
    </section>
  );
}

const CHOICES = [
  ['manual', 'When I say'],
  ['on_date', 'On a date'],
  ['monthly', 'Every month'],
] as const;
const HINTS = {
  manual: 'It waits in Prepared transfers. Nothing is sent until you tap Send and confirm.',
  on_date: 'It shows as due that day. Nothing is sent until you tap Send and confirm.',
  monthly: 'It shows as due that day each month. You tap Send and confirm each one.',
};
// These controls sit inside the transfer <form> (the designer's slot) but are not part of it:
// `form` names no form, so Enter in the note never submits "Review transfer" (which would create
// a proposal to send now) and an empty date never blocks it.
const DETACHED = 'prepare-later-detached';

function PrepareFields({
  busy,
  error,
  today,
  onSave,
}: {
  busy: boolean;
  error: string;
  today: string;
  onSave(choice: WhenChoice & { note: string }): void;
}) {
  const [when, setWhen] = useState<WhenChoice['when']>('manual'),
    [date, setDate] = useState(''),
    [day, setDay] = useState(1),
    [note, setNote] = useState(''),
    [missing, setMissing] = useState(false);
  const dateRef = useRef<HTMLInputElement>(null);
  function save(form: HTMLFormElement | null) {
    // The form's own messages for From, To, Amount and Description (shown inline by Transfers).
    if (form && !form.reportValidity()) return;
    if (when === 'on_date' && !date) {
      setMissing(true);
      dateRef.current?.focus();
      return;
    }
    onSave({
      when,
      ...(when === 'on_date' && { date }),
      ...(when === 'monthly' && { day }),
      note,
    });
  }
  const enter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    save(e.currentTarget.closest('form'));
  };
  return (
    <div id="prepare-later-group" className="prepare-group">
      <fieldset className="prepare-when" data-testid="prepare-when">
        <legend>When should it be ready?</legend>
        <div className="prepare-choices">
          {CHOICES.map(([value, label]) => (
            <label key={value} className="prepare-choice">
              <input
                className="sr-only"
                type="radio"
                name="prepare-when"
                form={DETACHED}
                value={value}
                checked={when === value}
                onChange={() => setWhen(value)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {when === 'on_date' && (
        <div className="prepare-detail">
          <label className="prepare-field">
            Date
            <input
              ref={dateRef}
              type="date"
              form={DETACHED}
              data-testid="prepare-date"
              min={today}
              max={addDays(today, 366)}
              value={date}
              aria-invalid={missing && !date}
              onChange={(e) => setDate(e.target.value)}
              onKeyDown={enter}
            />
          </label>
          <div className="prepare-chips" role="group" aria-label="Quick dates">
            {(
              [
                ['Tomorrow', 1],
                ['In 7 days', 7],
                ['In 30 days', 30],
              ] as const
            ).map(([label, days]) => (
              <button
                key={days}
                type="button"
                aria-pressed={date === addDays(today, days)}
                onClick={() => setDate(addDays(today, days))}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {when === 'monthly' && (
        <label className="prepare-field inline">
          On day
          <select
            form={DETACHED}
            data-testid="prepare-day"
            value={day}
            onChange={(e) => setDay(Number(e.target.value))}
          >
            {Array.from({ length: 31 }, (_, i) => (
              <option key={i + 1}>{i + 1}</option>
            ))}
          </select>
          of the month
        </label>
      )}
      <label className="prepare-field">
        {when === 'manual' ? 'Waiting for… (optional)' : 'Note to yourself (optional)'}
        <input
          form={DETACHED}
          data-testid="prepare-note"
          maxLength={140}
          placeholder={
            when === 'manual' ? 'e.g. until I get the keys' : 'e.g. check the amount first'
          }
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={enter}
        />
      </label>
      {(error || (missing && when === 'on_date' && !date)) && (
        <p className="prepare-error" role="alert">
          {error || 'Choose the date it should be ready.'}
        </p>
      )}
      <button
        type="button"
        className="primary-button"
        data-testid="prepare-save"
        disabled={busy}
        onClick={(e) => save(e.currentTarget.form)}
      >
        {busy ? 'Saving…' : 'Save prepared transfer'}
      </button>
      <p className="prepare-hint">
        {HINTS[when]}
        {when === 'monthly' && day > 28 && ' In shorter months it is due on the last day.'}
      </p>
    </div>
  );
}

// The control under "Review transfer": the same filled form, left ready instead of sent now.
export function PrepareLater({
  open,
  onToggle,
  busy = false,
  error = '',
  today = madridDay(),
  onSave,
}: {
  open: boolean;
  onToggle(): void;
  busy?: boolean;
  error?: string;
  today?: string;
  onSave(choice: WhenChoice & { note: string }): void;
}) {
  return (
    <div className="prepare-later">
      <button
        type="button"
        className="secondary-button"
        data-testid="prepare-later"
        aria-expanded={open}
        aria-controls="prepare-later-group"
        onClick={onToggle}
      >
        <Icon name="clock" size={16} />
        Prepare for later
      </button>
      {open && <PrepareFields busy={busy} error={error} today={today} onSave={onSave} />}
    </div>
  );
}

// The requests and their state, so the page only passes three props.
export function usePrepared({
  api,
  customerId,
  dashboard,
  refresh,
  form,
  clearForm,
  conversationId,
  showTransferResult,
  goTransfers,
}: {
  api(path: string, body?: unknown, method?: string): Promise<AnyRecord>;
  customerId: string | null;
  dashboard: AnyRecord | null;
  refresh(): Promise<void>;
  form: { from: string; to: string; amount: string; concept: string };
  clearForm(): void;
  conversationId: string | null;
  showTransferResult(result: AnyRecord): void;
  goTransfers(): void;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(''),
    [saveError, setSaveError] = useState(''),
    [message, setMessage] = useState<Message | null>(null),
    [focusId, setFocusId] = useState(''),
    [moveTo, setMoveTo] = useState<string | null>(null),
    // What skip, pause, resume and delete answered, shown until the next dashboard arrives: the
    // dashboard is a 504 while the bank is down, and a card left as it was would invite a second
    // skip (which skips one more month).
    [changed, setChanged] = useState<Record<string, PreparedView | null>>({});
  // A double click must not start two requests; the state above is one render late for that.
  const lock = useRef(false),
    who = useRef(customerId);
  who.current = customerId;
  useEffect(() => {
    setOpen(false);
    setBusy('');
    setSaveError('');
    setMessage(null);
    setFocusId('');
    setMoveTo(null);
    lock.current = false;
  }, [customerId]);
  useEffect(() => setChanged({}), [dashboard]);
  const items = ((dashboard?.prepared ?? []) as PreparedView[])
    .map((p) => (p.id in changed ? changed[p.id] : p))
    .filter((p): p is PreparedView => !!p);

  async function act(p: PreparedView, action: Action) {
    if (lock.current) return;
    lock.current = true;
    const me = customerId;
    setBusy(`${action}:${p.id}`);
    setMessage(null);
    let next: Message | null = null;
    try {
      const result =
        action === 'delete'
          ? await api(`prepared/${p.id}`, undefined, 'DELETE')
          : await api(`prepared/${p.id}/${action}`, action === 'send' ? { conversationId } : {});
      if (who.current !== me) return;
      if (action === 'send') {
        const { tone, text } = transferFeedback(result);
        // A proposal: the page focuses it in "Transfers to confirm"; the card then says it waits
        // there. A completed one has no card left: the page's notice says it.
        if (tone === 'pending' || tone === 'notice') showTransferResult(result);
        else next = { id: p.id, tone, text };
      } else if (action === 'delete') {
        setChanged((c) => ({ ...c, [p.id]: null }));
        setMoveTo(items[items.findIndex((x) => x.id === p.id) + 1]?.id ?? '');
        next = { id: '', tone: 'info', text: `Deleted: ${what(p)}. Nothing was sent.` };
      } else {
        const now = result.prepared as PreparedView;
        setChanged((c) => ({ ...c, [p.id]: now }));
        next = {
          id: p.id,
          tone: 'info',
          text:
            action === 'skip'
              ? `Skipped ${formatDay(p.nextDue!)} · next due ${formatDay(now.nextDue!)}. Nothing was sent.`
              : action === 'pause'
                ? 'Paused. Nothing becomes due until you resume.'
                : `Resumed · next due ${formatDay(now.nextDue!)}.`,
        };
      }
    } catch (e) {
      if (who.current === me) next = { id: p.id, tone: 'error', text: (e as Error).message };
    } finally {
      if (who.current === me) {
        await refresh().catch(() => {});
        setMessage(next);
        setBusy('');
      }
      lock.current = false;
    }
  }
  async function save(choice: WhenChoice & { note: string }) {
    if (lock.current) return;
    lock.current = true;
    const me = customerId;
    setBusy('save');
    setSaveError('');
    setMessage(null);
    try {
      const result = await api('prepared', {
        fromAccountId: form.from,
        toAccountId: form.to,
        // The typed text goes as is; the server parses it strictly, as for a transfer.
        amount: form.amount,
        concept: form.concept,
        ...choice,
        conversationId,
      });
      if (who.current !== me) return;
      if (result.status === 'prepared') {
        clearForm();
        setOpen(false);
        setFocusId(result.prepared.id);
        setMessage({
          id: result.prepared.id,
          tone: 'info',
          text: 'Saved. Nothing is sent until you tap Send and confirm.',
        });
        await refresh().catch(() => {});
      } else setSaveError(transferFeedback(result).text);
    } catch (e) {
      if (who.current === me) setSaveError((e as Error).message);
    } finally {
      if (who.current === me) setBusy('');
      lock.current = false;
    }
  }
  return {
    section: (
      <PreparedSection
        items={items}
        dashboard={dashboard ?? {}}
        busy={busy}
        message={message}
        focusId={focusId}
        onFocused={() => setFocusId('')}
        moveTo={moveTo}
        onMoved={() => setMoveTo(null)}
        onAct={act}
        onLeave={() => setMessage(null)}
      />
    ),
    formExtra: (
      <PrepareLater
        open={open}
        onToggle={() => {
          setOpen((v) => !v);
          setSaveError('');
        }}
        busy={busy === 'save'}
        error={saveError}
        onSave={save}
      />
    ),
    // Overview "For you to do": one row per due prepared transfer.
    attention: items
      .filter((p) => p.state === 'due')
      .map((p) => ({
        id: `prepared-${p.id}`,
        title: `Prepared transfer due: ${what(p)}`,
        detail: [preparedState(p), p.note && `“${stripBidi(p.note)}”`].filter(Boolean).join(' · '),
        actionLabel: 'Review',
        onAction() {
          goTransfers();
          setFocusId(p.id);
        },
      })),
  };
}
