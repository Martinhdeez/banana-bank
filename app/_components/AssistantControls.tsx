'use client';
// UI2 (plan 28 §6.1, REQ-PL-29): "What the assistant may do", the customer's controls over the
// assistant. A drawer in the pattern of AccountDrawer, opened from the Assistant header and from
// the sidebar's user block. Data: GET/POST /api/assistant-settings (AC1); a rule is removed with
// the spending card's own DELETE. `recorded[].text` is server text and is rendered as text; the
// record is the audit log, so nothing here edits or deletes it (plan 28 D3).
import { useEffect, useRef, useState } from 'react';
import { formatDate, shortRef, type AnyRecord } from '../../src/ui-helpers';
import { Icon } from './Icon';

export const CONTROLS_TITLE = 'What the assistant may do';
type Key = 'suggestions' | 'observations';
// `available` (AC1's review): false when the bank has the feature off by configuration; the
// customer's switch then has no effect, so it is shown as not available. Absent: available.
type Switch = { enabled: boolean; changedAt: string | null; available?: boolean };
type Rule = {
  merchantKey: string;
  name: string;
  category: string;
  categoryLabel: string;
  createdAt: string;
};
type Recorded = { at: string; kind: string; text: string; incidentId?: string };
export type AssistantSettings = Record<Key, Switch> & { rules: Rule[]; recorded: Recorded[] };

// Plan 28 §6.1, fixed interface strings: what "off" means for each switch.
const SWITCHES: { key: Key; title: string; off: string }[] = [
  {
    key: 'suggestions',
    title: 'Product suggestions in the chat',
    off: 'The assistant does not suggest products. If you ask about one, it answers from the product’s sheet and records nothing.',
  },
  {
    key: 'observations',
    title: '“Worth a look” observations',
    off: 'No “Worth a look” card and no observation in the chat. The month ahead and your goals are not affected.',
  },
];
// Each line checked against the 20 tools of src/agent/tools.ts: transfer_money and
// send_prepared_transfer only propose; every bank read is made as the signed-in customer (the
// assistant does read the recipients' names and account numbers, as the transfer form does, so
// the line names balances and movements, not "data"); no tool writes a limit or a fee.
const NEVER = [
  'Send money without your confirmation',
  'See another customer’s balances or movements',
  'Change a limit or a fee',
];
// The record holds at most this many rows (REQ-PL-4).
const RECORD_LIMIT = 50;

// A timestamp as its day ("6 Oct"), with the year only when it is not this year.
const day = (at: string) => formatDate(at, false).replace(` ${new Date().getFullYear()}`, '');

export function ControlsButton({ onClick, label = true }: { onClick(): void; label?: boolean }) {
  return (
    <button
      type="button"
      className={`controls-button${label ? '' : ' icon'}`}
      aria-label={CONTROLS_TITLE}
      title={label ? undefined : CONTROLS_TITLE}
      onClick={onClick}
    >
      <Icon name="sliders" size={16} />
      {label && <span>{CONTROLS_TITLE}</span>}
    </button>
  );
}

export type ControlsState = {
  settings: AssistantSettings | null;
  loadError: string;
  // The switch whose request is in flight, and the last failure of one.
  pending: Key | null;
  switchError: { key: Key; text: string } | null;
  // The rule being removed, and the line left by the last removal.
  removing: string;
  ruleNote: { kind: 'done' | 'error'; text: string } | null;
};

// The drawer's content, without the dialog: what the render tests read.
export function ControlsBody({
  state: { settings, loadError, pending, switchError, removing, ruleNote },
  onToggle,
  onRemove,
  onRetry,
}: {
  state: ControlsState;
  onToggle(key: Key): void;
  onRemove(rule: Rule): void;
  onRetry(): void;
}) {
  return (
    <div className="controls-body">
      {loadError ? (
        <section className="card load-error" role="alert">
          <h3>We could not load your settings</h3>
          <p>{loadError}</p>
          <button className="primary-button" type="button" onClick={onRetry}>
            Retry
          </button>
        </section>
      ) : !settings ? (
        <div className="controls-loading" role="status" aria-label="Loading your settings">
          <span className="card" />
          <span className="card" />
          <span className="card" />
        </div>
      ) : (
        <>
          <section className="card" aria-labelledby="controls-suggestions">
            <h3 id="controls-suggestions">Suggestions</h3>
            <p>You decide whether the assistant brings things up on its own.</p>
            {SWITCHES.map(({ key, title, off }) => {
              const value = settings[key];
              const available = value.available !== false;
              return (
                <div
                  className="controls-switch"
                  data-testid="assistant-setting"
                  data-key={key}
                  data-available={available}
                  key={key}
                >
                  <button
                    type="button"
                    role="switch"
                    aria-checked={available && value.enabled}
                    aria-label={title}
                    aria-describedby={`controls-off-${key}`}
                    aria-disabled={!available || undefined}
                    disabled={!available || pending !== null}
                    onClick={() => onToggle(key)}
                  >
                    <i aria-hidden="true" />
                  </button>
                  <div>
                    <span className="controls-switch-head">
                      <strong>{title}</strong>
                      <small className="controls-state" data-testid="assistant-setting-state">
                        {!available
                          ? 'Not available right now'
                          : (value.enabled ? 'On' : 'Off') +
                            (value.changedAt ? ` since ${day(value.changedAt)}` : '')}
                      </small>
                    </span>
                    <small id={`controls-off-${key}`}>
                      <b>Off:</b> {off}
                    </small>
                    {switchError?.key === key && (
                      <small className="controls-error" role="alert">
                        Not changed. {switchError.text}
                      </small>
                    )}
                  </div>
                </div>
              );
            })}
          </section>
          <section className="card" aria-labelledby="controls-rules">
            <h3 id="controls-rules">Your category rules</h3>
            <p>
              Removing a rule sends the movements it classified back to be classified again.
              Categories you set by hand stay.
            </p>
            {settings.rules.length === 0 && (
              <p className="controls-empty">
                No rules yet. One is made when you set a movement’s category and choose to apply it
                to that merchant’s other movements.
              </p>
            )}
            <ul className="controls-list" data-testid="assistant-rules">
              {settings.rules.map((r) => (
                <li key={r.merchantKey} data-merchant={r.merchantKey}>
                  <span>
                    <strong>
                      {r.name} <Icon name="arrow" size={13} />
                      <span className="sr-only">is always</span> {r.categoryLabel}
                    </strong>
                    <small>since {day(r.createdAt)}</small>
                  </span>
                  <button
                    type="button"
                    className="controls-link"
                    aria-label={`Remove the rule for ${r.name}`}
                    disabled={removing !== ''}
                    onClick={() => onRemove(r)}
                  >
                    {removing === r.merchantKey ? 'Removing…' : 'Remove'}
                  </button>
                </li>
              ))}
            </ul>
            {/* Always mounted, so the line is announced when it appears. */}
            <p
              className={`controls-note ${ruleNote?.kind ?? ''}`}
              role={ruleNote?.kind === 'error' ? 'alert' : 'status'}
            >
              {ruleNote?.kind === 'done' && <Icon name="check" size={15} />}
              {ruleNote?.text}
            </p>
          </section>
          <section className="card" aria-labelledby="controls-recorded">
            <h3 id="controls-recorded">What the assistant has noted about you</h3>
            <p>Kept as the bank’s record of what was shown to you. It cannot be edited.</p>
            {settings.recorded.length === 0 && <p className="controls-empty">Nothing yet.</p>}
            <ul className="controls-list recorded" data-testid="assistant-record">
              {settings.recorded.map((r, i) => (
                <li key={i} data-kind={r.kind}>
                  <time dateTime={r.at}>{day(r.at)}</time>
                  <span>
                    <strong>{r.text}</strong>
                    {/* The reference the chat shows for a support request (shortRef). */}
                    {r.incidentId && <small>Support request {shortRef(r.incidentId)}</small>}
                  </span>
                </li>
              ))}
            </ul>
            {settings.recorded.length >= RECORD_LIMIT && (
              <p className="controls-empty">Showing the latest {RECORD_LIMIT}.</p>
            )}
          </section>
        </>
      )}
      <section className="card" aria-labelledby="controls-never">
        <h3 id="controls-never">What it can never do</h3>
        <ul className="controls-never">
          {NEVER.map((n) => (
            <li key={n}>
              <span aria-hidden="true">
                <Icon name="lock" size={15} />
              </span>
              {n}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// Native <dialog>, as AccountDrawer: showModal() traps focus, Esc and the backdrop close it, and
// focus returns to the opener.
function Drawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose(): void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="account-drawer controls-drawer"
      data-testid="assistant-controls"
      aria-labelledby="controls-title"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && ref.current?.close()}
    >
      {open && (
        <>
          <div className="drawer-head">
            <h2 id="controls-title">{CONTROLS_TITLE}</h2>
            <button
              type="button"
              className="icon-button close"
              aria-label="Close"
              onClick={() => ref.current?.close()}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          {children}
        </>
      )}
    </dialog>
  );
}

// After a failed POST of a switch (network error, 5xx, 429) the change may still have been
// applied and only its answer lost: one re-read says which. The server's settings when the
// switch is no longer what it was; null when it is unchanged or the re-read fails too.
export async function appliedAfterFailure(
  api: (path: string) => Promise<AnyRecord>,
  key: Key,
  was: boolean,
) {
  const settings = (await api('assistant-settings').catch(() => null)) as AssistantSettings | null;
  return settings && settings[key]?.enabled !== was ? settings : null;
}

const CLOSED: ControlsState = {
  settings: null,
  loadError: '',
  pending: null,
  switchError: null,
  removing: '',
  ruleNote: null,
};

// The requests and their state, so the page passes one node and one opener. `refresh` is the
// page's dashboard read: after a change the "Worth a look" card and the spending card's rules
// (which follow every dashboard read) show the same thing as this drawer.
export function useAssistantControls({
  api,
  customerId,
  refresh,
}: {
  api(path: string, body?: unknown, method?: string): Promise<AnyRecord>;
  customerId: string | null;
  refresh(): Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [state, setState] = useState(CLOSED);
  // One request at a time, and none of them lands on another person's screen.
  const lock = useRef(false),
    who = useRef(customerId);
  who.current = customerId;
  useEffect(() => {
    setOpen(false);
    setState(CLOSED);
    lock.current = false;
  }, [customerId]);
  const patch = (p: Partial<ControlsState>) => setState((s) => ({ ...s, ...p }));

  async function load() {
    const me = customerId;
    patch({ loadError: '' });
    try {
      const settings = (await api('assistant-settings')) as AssistantSettings;
      if (who.current === me) patch({ settings });
    } catch (e) {
      if (who.current === me) patch({ settings: null, loadError: (e as Error).message });
    }
  }
  // One switch, one field. Shown at once. When the request fails the server is asked once what
  // it holds: put back, with the server's sentence (429 included), only if nothing was changed.
  async function toggle(key: Key) {
    const before = state.settings?.[key];
    if (lock.current || !before || before.available === false) return;
    lock.current = true;
    const me = customerId,
      enabled = !before.enabled;
    const show = (value: Switch) =>
      setState((s) => (s.settings ? { ...s, settings: { ...s.settings, [key]: value } } : s));
    show({ ...before, enabled, changedAt: new Date().toISOString() });
    patch({ pending: key, switchError: null });
    try {
      const settings = (await api('assistant-settings', { [key]: enabled })) as AssistantSettings;
      if (who.current === me) {
        patch({ settings });
        await refresh().catch(() => {});
      }
    } catch (e) {
      const settings = await appliedAfterFailure(api, key, before.enabled);
      if (who.current === me) {
        if (settings) {
          patch({ settings });
          await refresh().catch(() => {});
        } else {
          show(before);
          patch({ switchError: { key, text: (e as Error).message } });
        }
      }
    }
    lock.current = false;
    if (who.current === me) patch({ pending: null });
  }
  async function remove(rule: Rule) {
    if (lock.current) return;
    lock.current = true;
    const me = customerId;
    patch({ removing: rule.merchantKey, ruleNote: null });
    let ruleNote: ControlsState['ruleNote'];
    try {
      const r = await api(
        `insights/rules/${encodeURIComponent(rule.merchantKey)}`,
        undefined,
        'DELETE',
      );
      const n = r.reclassified ?? 0;
      ruleNote = {
        kind: 'done',
        text:
          `Removed the rule for ${rule.name}.` +
          (n ? ` ${n} ${n === 1 ? 'movement' : 'movements'} sent back to be classified.` : ''),
      };
    } catch (e) {
      ruleNote = { kind: 'error', text: `Not removed. ${(e as Error).message}` };
    }
    if (who.current === me) {
      // Re-read, whatever the answer: the list shown is the server's.
      await load();
      await refresh().catch(() => {});
    }
    lock.current = false;
    if (who.current === me) patch({ removing: '', ruleNote });
  }
  return {
    // Every opening reads again.
    open() {
      setState(CLOSED);
      setOpen(true);
      load();
    },
    drawer: customerId && (
      <Drawer open={open} onClose={() => setOpen(false)}>
        <ControlsBody state={state} onToggle={toggle} onRemove={remove} onRetry={load} />
      </Drawer>
    ),
  };
}
