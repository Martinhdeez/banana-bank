'use client';
import { useEffect, useRef, useState } from 'react';
import type { Person } from '../src/types';
import { groupRecipients, mainAccount, rankRecipients } from '../src/banking/recipients';
import {
  accountActivity,
  favouriteChange,
  hasReceipt,
  paidLine,
  parseTab,
  readJson,
  transferFeedback,
  type ActivityRow,
  type AnyRecord,
  type Tab,
} from '../src/ui-helpers';
import { Alerts, LoadError, Shell } from './_components/Shell';
import { AiUsage } from './_components/AiUsage';
import { Overview } from './_components/Overview';
import { AccountDrawer } from './_components/AccountDrawer';
import { Assistant, askForSupport, type SupportState } from './_components/Assistant';
import { Transfers } from './_components/Transfers';
import { Approvals } from './_components/Approvals';
import { Cases } from './_components/Cases';
import { Documents } from './_components/Documents';
import { NotificationBell } from './_components/NotificationBell';
import { useMovementSearch } from './_components/MovementFilters';
import { usePrepared } from './_components/Prepared';
import { useObservation } from './_components/Observation';
import { usePlan } from './_components/Plan';
import { ControlsButton, useAssistantControls } from './_components/AssistantControls';
import { CategoryChip, SpendingCard, useSpendInsights } from './_components/SpendInsights';
import {
  AttachedMovement,
  ASK_SPENDING,
  chatSuggestions,
  askText,
  createdPlans,
  messageExtras,
} from './_components/ChatInsights';
import type { AttachedMovement as Movement } from '../src/agent/extras';
import type { NotificationItem } from '../src/notifications';
// SEC3: any 401 (expired, pre-SEC3 or missing session) is reported to the page, which goes back
// to person selection instead of showing the error on whatever screen made the call.
let onSessionLost = (_message: string) => {};
async function api(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  headers?: Record<string, string>,
) {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  try {
    return await readJson(response);
  } catch (e) {
    if (response.status === 401) onSessionLost((e as Error).message);
    // UI1: the status goes with the error (a 404 on /api/goals is a server without goals).
    throw Object.assign(e as Error, { status: response.status });
  }
}
export default function Home() {
  const [people, setPeople] = useState<Person[]>([]),
    [current, setCurrent] = useState<Person | null>(null),
    // U1: the person asked for, kept while the session loads (or fails) so Retry can ask again.
    [personId, setPersonId] = useState(''),
    [tab, setTab] = useState<Tab>('overview'),
    [collapsed, setCollapsed] = useState(false);
  const [dashboard, setDashboard] = useState<AnyRecord | null>(null),
    [conversations, setConversations] = useState<AnyRecord[]>([]),
    [conversationId, setConversationId] = useState<string | null>(null),
    [messages, setMessages] = useState<AnyRecord[]>([]);
  const [text, setText] = useState(''),
    // U1: one busy flag per action, so one action never ends or fakes another one's progress.
    // U10: the chat turn in flight belongs to one conversation ('new' until it has an id).
    [busyId, setBusyId] = useState<string | null>(null),
    // U10: the text of a failed send stays on screen with Retry.
    // SI7b: `movement` says the failed send carried the attachment, so Retry sends it again.
    [failed, setFailed] = useState<{
      conversationId: string | null;
      content: string;
      movement: boolean;
    } | null>(null),
    // SI7b: the movement that goes with the next message ("Ask the assistant" on Overview).
    [attached, setAttached] = useState<Movement | null>(null),
    // HS1: support asked from a failed turn, per conversation id.
    [support, setSupport] = useState<Record<string, SupportState>>({}),
    [transferBusy, setTransferBusy] = useState(false),
    [searchBusy, setSearchBusy] = useState(false),
    [ingestBusy, setIngestBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    // B3: the session or the last dashboard read failed. Kept apart from `error`, which every
    // tab change clears: Transfers and Assistant showed the spinner for ever with the bank down.
    [loadError, setLoadError] = useState(''),
    [retrying, setRetrying] = useState(false);
  const [docs, setDocs] = useState<AnyRecord[]>([]),
    [document, setDocument] = useState<AnyRecord | null>(null),
    [query, setQuery] = useState(''),
    [sources, setSources] = useState<AnyRecord[] | null>(null),
    // DL1: library filters and the cited excerpt to highlight in the reader.
    [docFilter, setDocFilter] = useState({ product: '', validity: '' }),
    [products, setProducts] = useState<string[]>([]),
    // U11: the library is loading (no "0 sources" before the list arrives).
    [docsLoading, setDocsLoading] = useState(false),
    [cited, setCited] = useState<{ documentId: string; text: string } | null>(null);
  const [selectedCase, setSelectedCase] = useState<AnyRecord | null>(null),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [amount, setAmount] = useState(''),
    [concept, setConcept] = useState('');
  // IT8-ui: the period of the spending card: 'current', a month 'YYYY-MM' or 'all'. Not kept
  // across a reload or a change of person. A ref, so every refresh() caller (the 20 s tick, the
  // insights hook) reads the chosen one, never a stale closure; the state copy renders the card.
  // DS2: it opens on the last full month. The first read asks for `last` (the server's clock
  // names the month) and the month it answers becomes the chosen period, so the trigger, the
  // caption and the pressed options all show a value that was sent, like any other choice.
  const period = useRef('last');
  const [shownPeriod, setShownPeriod] = useState('last');
  function selectPeriod(id: string) {
    period.current = id;
    setShownPeriod(id);
    refresh().catch(() => {});
  }
  // F5d: operator inbox refresh (on demand and after resolving) and audited case resolution.
  const [caseBusy, setCaseBusy] = useState(false);
  // S6: "Mark resolved" asks "Are you sure?" inline; only the second click resolves.
  const [confirmResolve, setConfirmResolve] = useState(false);
  useEffect(() => setConfirmResolve(false), [selectedCase?.incident.id]);
  // OPX3: inbox filters run on the server, 250 ms after the last change; a stale response is
  // dropped. No filter set: the dashboard's inbox, no extra request. Re-run when it refreshes.
  const [caseFilters, setCaseFilters] = useState({ q: '', money: false, reason: '' }),
    [caseResults, setCaseResults] = useState<AnyRecord[] | null>(null),
    [caseFiltering, setCaseFiltering] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams();
    if (caseFilters.q.trim()) params.set('q', caseFilters.q.trim());
    if (caseFilters.money) params.set('money', 'true');
    if (caseFilters.reason) params.set('reason', caseFilters.reason);
    if (!params.size) {
      setCaseResults(null);
      setCaseFiltering(false);
      return;
    }
    let live = true;
    setCaseFiltering(true);
    const timer = setTimeout(
      () =>
        api(`incidents?${params}`)
          .then((rows) => live && setCaseResults(rows))
          .catch((e) => live && setError((e as Error).message))
          .finally(() => live && setCaseFiltering(false)),
      250,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [caseFilters, dashboard]);
  async function refreshCases(caseId?: string, resolve = false) {
    const g = generation.current;
    setCaseBusy(true);
    try {
      if (caseId) {
        const d = await api(
          `incidents/${caseId}${resolve ? '/resolve' : ''}`,
          resolve ? { confirm: true } : undefined,
        );
        if (g === generation.current) setSelectedCase(d);
      }
      await refresh(g);
    } catch (e) {
      if (g === generation.current) setError((e as Error).message);
    } finally {
      if (g === generation.current) setCaseBusy(false);
    }
  }
  const activeConversation = useRef<string | null>(null),
    busyRef = useRef<string | null>(null),
    supportRef = useRef<Record<string, SupportState>>({});
  const generation = useRef(0),
    // B11: the message of the last failed dashboard read, '' once a read succeeds.
    readError = useRef(''),
    // CF4-ui: the favourites/recent the recipient order was ranked with (per generation). CF6: per
    // person (keyed by generation and main account), the star state last asked for, when, and
    // whether a save is running.
    rankBasis = useRef<{ g: number; recipients?: Parameters<typeof rankRecipients>[1] } | null>(
      null,
    ),
    favouriteWanted = useRef(new Map<string, { wanted: boolean; at: number; busy: boolean }>()),
    messagesEnd = useRef<HTMLDivElement>(null);
  // SEC3: drop the persona's screen (and any call still in flight for it) and show LoadError with
  // the server's message; Retry or the person picker selects again.
  useEffect(() => {
    onSessionLost = (message) => {
      generation.current++;
      setCurrent(null);
      setDashboard(null);
      setConversations([]);
      setLoadError(message);
    };
  }, []);
  // O5: on a phone the case detail / document reader sits below its list. When one opens, bring
  // it into view (only if its top is off-screen, so wide layouts do not jump) and move focus to it.
  const caseDetailRef = useRef<HTMLElement>(null),
    readerRef = useRef<HTMLElement>(null);
  function reveal(el: HTMLElement | null) {
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight / 2) el.scrollIntoView({ block: 'start' });
    el.focus({ preventScroll: true });
  }
  const caseShown = selectedCase?.incident.id,
    documentShown = document?.id;
  // Restored after mount (not in useState) so server and first client render match.
  useEffect(() => setCollapsed(localStorage.getItem('banana_sidebar') === 'collapsed'), []);
  function toggleSidebar() {
    localStorage.setItem('banana_sidebar', collapsed ? 'open' : 'collapsed');
    setCollapsed(!collapsed);
  }
  useEffect(() => {
    if (caseShown) reveal(caseDetailRef.current);
  }, [caseShown]);
  useEffect(() => {
    if (documentShown) reveal(readerRef.current);
    // DL1: bring the highlighted excerpt into view inside the reader.
    readerRef.current?.querySelector('mark')?.scrollIntoView({ block: 'nearest' });
  }, [documentShown, cited]);
  async function refresh(g = generation.current) {
    // IT8-ui: `insights` is asked for the period chosen on the spending card (the last full
    // month by default, DS2), in the same bank read; everything else in the answer ignores the
    // parameter.
    // The period goes in a request header (contracts.md 2.19), never in the query: the URL
    // stays `/api/dashboard`.
    const asked = period.current;
    let data: AnyRecord;
    try {
      data = await api('dashboard', undefined, 'GET', { 'x-insights-period': asked });
    } catch (e) {
      // B3: every failed read is recorded here, whoever asked and whatever they do with it.
      if (g === generation.current) {
        readError.current = (e as Error).message;
        setLoadError(readError.current);
      }
      throw e;
    }
    // An answer for a period that is no longer the chosen one is dropped: its own read follows.
    if (g !== generation.current || asked !== period.current) return;
    if (asked === 'last' && data.insights?.period) {
      period.current = data.insights.period;
      setShownPeriod(data.insights.period);
    }
    setDashboard(data);
    // B11: a real successful read ends the load error and takes down the banner a failed read
    // left ("The bank did not respond"); any other error stays until dismissed.
    const stale = readError.current;
    readError.current = '';
    setLoadError('');
    if (stale) setError((e) => (e === stale ? '' : e));
    // CF4-ui: the recipient order is taken from the first dashboard of this person (or reload).
    if (rankBasis.current?.g !== g) rankBasis.current = { g, recipients: data.recipients };
    if (data.accounts?.length)
      // A6 (polish): the main account by default, as in Overview; a chosen one is kept.
      setFrom((v) =>
        data.accounts.some((a: AnyRecord) => a.id === v)
          ? v
          : mainAccount<AnyRecord>(data.accounts).id,
      );
  }
  // U2: the last result or alert belongs to the screen and action that produced it.
  function clearFeedback() {
    setError('');
    setNotice('');
    setWarning('');
    setConfirmResult(null);
  }
  // U5: the tab lives in the URL (?tab=), so reload and back keep the place. Native pushState
  // syncs with the Next router; useSearchParams would need a Suspense boundary here.
  function go(t: Tab, push = true) {
    setTab(t);
    clearFeedback();
    if (push && window.location.search !== `?tab=${t}`)
      window.history.pushState(null, '', `?tab=${t}`);
  }
  // `search` is the URL query to restore the tab from; a persona switch passes '' (role default).
  async function selectPerson(id: string, search = '') {
    const g = ++generation.current;
    setPersonId(id);
    setCurrent(null);
    setDashboard(null);
    period.current = 'last';
    setShownPeriod('last');
    setConversations([]);
    activeConversation.current = null;
    setConversationId(null);
    setMessages([]);
    setSelectedCase(null);
    setCaseBusy(false);
    setDocument(null);
    setDocs([]);
    setDocsLoading(false);
    setSources(null);
    setQuery(''); // O5: a search typed as one persona is not carried to the next.
    setDocFilter({ product: '', validity: '' });
    setCited(null);
    setError('');
    setLoadError('');
    readError.current = '';
    setNotice('');
    setWarning('');
    setBusyId(null);
    busyRef.current = null;
    setFailed(null);
    setAttached(null);
    setTransferBusy(false);
    setSearchBusy(false);
    setIngestBusy(false);
    setConfirming('');
    setReviewId('');
    setAllActivity(false);
    setDrawerAccountId(null);
    setConfirmResult(null);
    setText('');
    setFrom('');
    setTo('');
    setAmount('');
    setConcept('');
    let t: Tab, role: string;
    try {
      const result = await api('session', { userId: id });
      if (g !== generation.current) return;
      role = result.person.role;
      t = parseTab(search, result.person.role);
      setCurrent(result.person);
      setTab(t);
      window.history.replaceState(null, '', `?tab=${t}`);
      try {
        localStorage.setItem('banana_person', id);
      } catch {}
    } catch (e) {
      if (g === generation.current) setLoadError((e as Error).message);
      return;
    }
    // B3: three independent reads. The conversations and the library do not need the bank, so a
    // failed dashboard (recorded by refresh) no longer leaves them unasked.
    const failed = (e: unknown) => g === generation.current && setError((e as Error).message);
    await Promise.all([
      refresh(g).catch(() => {}),
      t === 'documents' && loadDocs({ product: '', validity: '' }, g).catch(failed),
      role === 'customer' && loadConversations(g).catch(failed),
    ]);
  }
  async function loadConversations(g = generation.current) {
    const cs = await api('conversations');
    if (g === generation.current) setConversations(cs);
  }
  // B3: Retry with a person selected only repeats the reads (the tab, the open conversation and a
  // typed draft stay); without one it selects the person again.
  async function retryLoad() {
    if (!current) return selectPerson(personId, window.location.search);
    setRetrying(true);
    await Promise.all([
      refresh().catch(() => {}),
      customerId && !conversations.length && loadConversations().catch(() => {}),
    ]);
    setRetrying(false);
  }
  useEffect(() => {
    // D6: the session cookie is HttpOnly, so asking GET /api/session on a first visit only
    // produced 401s. Re-select the last person remembered here instead (Lucía by default,
    // also when the remembered id no longer exists).
    let last: string | null = null;
    try {
      last = localStorage.getItem('banana_person');
    } catch {}
    api('people').then((list: Person[]) => {
      setPeople(list);
      selectPerson(list.some((p) => p.id === last) ? last! : 'lucia', window.location.search);
    });
  }, []);
  // R3/R4/R7: Recent activity went stale: the dashboard was read only on persona switch and after
  // this browser's own actions, never when returning to Overview nor when someone else paid in.
  // Now it is re-read when Overview/Transfers is shown and every 20 s while the page is visible
  // (each read also re-checks unknown transfer outcomes on the server, throttled).
  const customerId = current?.role === 'customer' ? current.id : null;
  // CF3-ui: movement search in the Overview toolbar (GET /api/movements).
  const movementSearch = useMovementSearch(api, customerId, dashboard);
  // SI7a: spend insights on Overview (card and row chips), from `dashboard.insights`.
  const insights = useSpendInsights(api, customerId, dashboard, refresh);
  useEffect(() => {
    if (customerId && (tab === 'overview' || tab === 'transfers' || tab === 'goals'))
      refresh().catch(() => {});
  }, [tab]);
  // B11: after a failed read the next one comes in 5 s, not on the 20 s tick, so a row or a
  // banner left by an action taken while the bank was down is corrected soon after it is back.
  const personShown = current?.id;
  useEffect(() => {
    if (!personShown || !loadError) return;
    const timer = setInterval(
      () => window.document.visibilityState === 'visible' && refresh().catch(() => {}),
      5_000,
    );
    return () => clearInterval(timer);
  }, [personShown, loadError]);
  // U5: back/forward restore the tab named in the URL (re-subscribed each render: fresh closure).
  const role = current?.role;
  useEffect(() => {
    if (!role) return;
    const onPop = () => show(parseTab(window.location.search, role), false);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  });
  function show(t: Tab, push = true) {
    if (t === 'documents') openLibrary(docFilter, push);
    else go(t, push);
  }
  // Finding D (DV7): the open conversation is re-read on the same tick, so an outcome note the
  // server adds later (e.g. pending_verification -> completed) shows without reopening the chat.
  // Paused while a send is in flight, so it never replaces the optimistic message (U10).
  async function pollConversation() {
    const g = generation.current,
      id = activeConversation.current;
    if (!id || busyRef.current !== null) return;
    const c = await api(`conversations/${id}`);
    if (g !== generation.current || activeConversation.current !== id || busyRef.current !== null)
      return;
    // Same thread: keep the old array so the scroll effect does not jump every 20 s.
    setMessages((m) => (JSON.stringify(m) === JSON.stringify(c.messages) ? m : c.messages));
  }
  useEffect(() => {
    if (!customerId) return;
    const tick = () => {
      if (window.document.visibilityState !== 'visible') return;
      refresh().catch(() => {});
      pollConversation().catch(() => {});
      loadNotifications().catch(() => {});
    };
    const timer = setInterval(tick, 20_000);
    window.document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      window.document.removeEventListener('visibilitychange', tick);
    };
  }, [customerId]);
  // CF5-ui: notifications for the signed-in customer only, re-read on the 20 s tick above (paused
  // while the tab is hidden). A persona switch or a lost session (no customer) clears them.
  const [notes, setNotes] = useState<{ unread: number; items: NotificationItem[] } | null>(null);
  async function loadNotifications(g = generation.current) {
    const n = await api('notifications');
    if (g === generation.current) setNotes(n);
  }
  useEffect(() => {
    setNotes(null);
    if (customerId) loadNotifications().catch(() => {});
  }, [customerId]);
  // Opening the bell marks what it shows as read: optimistic, then POST and re-read.
  function openNotifications() {
    const g = generation.current,
      ids = notes?.items.filter((n) => !n.read).map((n) => n.id) ?? [];
    setNotes((n) => n && { unread: 0, items: n.items.map((i) => ({ ...i, read: true })) });
    (ids.length ? api('notifications/read', { ids }) : Promise.resolve())
      .then(() => loadNotifications(g))
      .catch(() => {});
  }
  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, busyId, support]);
  async function openConversation(id: string) {
    // U2: the picker's "New conversation" option has value ''.
    if (!id) return newConversation();
    const g = generation.current;
    activeConversation.current = id;
    setConversationId(id);
    go('assistant');
    setMessages([]);
    try {
      const c = await api(`conversations/${id}`);
      if (g === generation.current && activeConversation.current === id) setMessages(c.messages);
    } catch (e) {
      if (g === generation.current && activeConversation.current === id)
        setError((e as Error).message);
    }
  }
  // U2/U5: a new conversation is only a cleared view; send() creates it on the first message,
  // so empty "New conversation" rows no longer pile up.
  function newConversation() {
    activeConversation.current = null;
    setConversationId(null);
    setMessages([]);
    go('assistant');
  }
  function busy(id: string | null) {
    busyRef.current = id;
    setBusyId(id);
  }
  // SI7b: `movement` is the attachment sent with the message (contracts.md §3: only its id; the
  // body is strict). A quick-reply click passes null: the server knows what the reply is about.
  async function send(value = text, movement: Movement | null = attached) {
    if (!value.trim() || busyRef.current !== null || !current) return;
    const g = generation.current;
    // The ref, not the state: `ask` sends right after it cleared the open conversation.
    let id = activeConversation.current,
      sendError = '';
    busy(id ?? 'new');
    setFailed(null);
    clearFeedback();
    // Review of #106: a quick reply, a suggestion or "Ask the assistant" keeps a typed draft.
    if (value === text) setText('');
    try {
      if (!id) {
        const c = await api('conversations', {});
        if (g !== generation.current) return;
        id = c.id as string;
        busy(id);
        activeConversation.current = id;
        setConversationId(id);
      }
      go('assistant');
      setMessages((m) => [
        ...m,
        {
          id: 'pending-user',
          role: 'user',
          content: value,
          created_at: new Date().toISOString(),
          extras: movement && { movement },
        },
      ]);
      await api(`conversations/${id}/messages`, {
        content: value,
        ...(movement && { movementId: movement.id }),
      });
      // Stored with the message: the composer is free again (unless another one was attached).
      if (movement && g === generation.current)
        setAttached((a) => (a?.id === movement.id ? null : a));
    } catch (e) {
      // Nothing was stored (unknown movement: 404; bank failure: 504): the attachment stays in
      // the composer and the text in the failed bubble, so Retry sends both again.
      if (g === generation.current) {
        sendError = (e as Error).message;
        setFailed({ conversationId: id, content: value, movement: !!movement });
      }
    } finally {
      if (g === generation.current) {
        try {
          if (id) {
            const c = await api(`conversations/${id}`);
            // HS1, HS2: a failed turn's sentence is the answer stored in the thread (marked
            // `extras.turnFailed`, with "Ask for human support"); the banner does not repeat it.
            // Any other error (409, 429: nothing stored) is not that message's text.
            const last = c.messages.at(-1);
            if (last?.extras?.turnFailed && last.content === sendError) sendError = '';
            if (g === generation.current && activeConversation.current === id)
              setMessages(c.messages);
          }
          if (sendError && g === generation.current) setError(sendError);
          const cs = await api('conversations');
          if (g === generation.current) setConversations(cs);
          await refresh(g);
        } catch (e) {
          // D4: a failed reload leaves stale messages; say so instead of hiding it.
          if (g === generation.current) setError((e as Error).message);
        }
        if (g === generation.current) busy(null);
      }
    }
  }
  // SI7b: the view changed (or the control that was used is gone); the keyboard continues in the
  // composer. Not on touch devices (review of #106): focus there opens the on-screen keyboard
  // over the answer the customer asked for.
  const focusComposer = () =>
    window.matchMedia('(pointer: coarse)').matches ||
    setTimeout(() =>
      window.document
        .querySelector<HTMLElement>('textarea[aria-label="Message the assistant"]')
        ?.focus(),
    );
  // HS1: "Ask for human support" on a failed turn opens the conversation's case without the
  // model. The ref is the double-submit guard; the state is what renders. HS2: the confirmation
  // is the message the server stored, read again here; the button it replaces is gone, so the
  // keyboard continues in the composer.
  const askSupport = () => {
    const id = activeConversation.current,
      g = generation.current;
    if (id)
      askForSupport(
        id,
        supportRef.current,
        api,
        () => g === generation.current && setSupport({ ...supportRef.current }),
        async () => {
          const c = await api(`conversations/${id}`);
          if (g !== generation.current || activeConversation.current !== id) return;
          setMessages(c.messages);
          focusComposer();
        },
      );
  };
  // REQ-SI7-8: "Ask the assistant" on a chip opens a new conversation with the movement attached
  // and asks at once. While a turn runs elsewhere the movement waits in the composer.
  function ask(row: ActivityRow) {
    const c = row.category!;
    const movement = {
      id: c.movementIds[0],
      title: row.title,
      amountCents: row.amountCents,
      createdAt: row.createdAt,
    };
    newConversation();
    setAttached(movement);
    focusComposer();
    send(askText(c), movement);
  }
  // "Resolve in chat" on a review group: the same, with the row of the group's first movement.
  function askMovement(movementId: string) {
    const row = accountActivity(dashboard ?? {}, null, Infinity).find((r) =>
      r.category?.movementIds.includes(movementId),
    );
    if (row) ask(row);
  }
  // A5: "Ask about my spending" on the insights card: a new conversation that asks at once.
  // Overview v3: the same from the Assistant card of Overview, with the text typed or picked there.
  function askAssistant(value: string) {
    newConversation();
    focusComposer();
    send(value, null);
  }
  const askSpending = () => askAssistant(ASK_SPENDING);
  async function openLibrary(filter = docFilter, push = true) {
    const g = generation.current;
    go('documents', push);
    setDocument(null);
    setCited(null);
    try {
      await loadDocs(filter, g);
    } catch (e) {
      if (g === generation.current) setError((e as Error).message);
    }
  }
  // DL1: the server filters by product and validity (same validity rule as retrieval).
  async function loadDocs(filter = docFilter, g = generation.current) {
    const query = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
    setDocsLoading(true);
    try {
      const result = await api(query ? `documents?${query}` : 'documents');
      if (g !== generation.current) return;
      setDocs(result.documents);
      setProducts(result.products ?? []);
    } finally {
      if (g === generation.current) setDocsLoading(false);
    }
  }
  // F2b: one intentId per form submission, so a double submit or retry in flight maps to the
  // same proposal (contract: retrying an intent must not multiply its effects).
  const formIntent = useRef('');
  // U3: failed/pending transfers are an error/warning, never the green notice.
  const [warning, setWarning] = useState('');
  const [allActivity, setAllActivity] = useState(false);
  // Account drawer (Overview): the account id; the account itself is read from the latest dashboard.
  const [drawerAccountId, setDrawerAccountId] = useState<string | null>(null);
  function startTransfer({ from, to }: { from?: string; to?: string }) {
    if (from) setFrom(from);
    if (to) setTo(to);
    go('transfers');
  }
  // R1: a new proposal is not announced with the success banner; its row in the proposals panel
  // (pending style) is scrolled into view and focused instead.
  const [reviewId, setReviewId] = useState('');
  useEffect(() => {
    const row = reviewId && window.document.getElementById(`proposal-${reviewId}`);
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    row.focus({ preventScroll: true });
    setReviewId('');
  }, [reviewId, dashboard]);
  function showTransferResult(result: AnyRecord) {
    const { tone, text } = transferFeedback(result);
    if (tone === 'pending') return setReviewId(result.approval?.id ?? '');
    (tone === 'notice' ? setNotice : tone === 'warning' ? setWarning : setError)(text);
  }
  // F4b/F4d: open a cited or retrieved source in the library. DL1: with the cited chunk id, the
  // chunk's text is loaded so the reader highlights the excerpt the answer rested on.
  async function openSource(id: string, chunkId?: string) {
    const g = generation.current;
    await openLibrary();
    try {
      const doc = encodeURIComponent(id);
      const [result, chunks] = await Promise.all([
        api(`documents/${doc}`),
        chunkId ? api(`documents/${doc}/chunks`) : [],
      ]);
      if (g !== generation.current) return;
      const chunk = (chunks as AnyRecord[]).find((c) => c.id === chunkId);
      setCited(chunk ? { documentId: id, text: chunk.text } : null);
      setDocument(result);
    } catch (e) {
      if (g === generation.current) setError((e as Error).message);
    }
  }
  async function submitTransfer() {
    const g = generation.current;
    formIntent.current ||= `form-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setTransferBusy(true);
    clearFeedback();
    try {
      const result = await api('actions', {
        name: 'transfer_money',
        arguments: {
          fromAccountId: from,
          toAccountId: to,
          // S1: the typed text goes as is; the server parses it strictly (no Number() coercion).
          amount: amount.trim(),
          concept,
        },
        conversationId,
        intentId: formIntent.current,
      });
      formIntent.current = '';
      if (g !== generation.current) return;
      showTransferResult(result);
      // X4: the proposal now holds these details; an untouched form would invite a second one.
      if (result.status === 'requires_confirmation') {
        setTo('');
        setAmount('');
        setConcept('');
      }
      await refresh(g);
    } catch (e) {
      formIntent.current = '';
      if (g === generation.current) setError((e as Error).message);
    } finally {
      if (g === generation.current) setTransferBusy(false);
    }
  }
  // U8: guard against a double click (the server confirm is single-use anyway, F2).
  const [confirming, setConfirming] = useState('');
  // X1: the confirm outcome stays in the proposals panel, where the customer clicked.
  const [confirmResult, setConfirmResult] = useState<AnyRecord | null>(null);
  const confirmResultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (confirmResult) confirmResultRef.current?.focus();
  }, [confirmResult]);
  // R5: cancel shares the confirm flow (guard, result in the panel, refresh).
  async function confirm(a: AnyRecord, action: 'confirm' | 'cancel' = 'confirm') {
    if (confirming) return;
    setConfirming(`${action}:${a.id}`);
    const g = generation.current;
    clearFeedback();
    try {
      let outcome;
      try {
        const result = await api(`approvals/${a.id}/${action}`, {});
        // Follow-up 3a: the intent id ties an unconfirmed result to its row once it settles.
        outcome = {
          ...transferFeedback(result),
          status: result.status,
          intentId: result.intentId,
        };
      } catch (e) {
        outcome = { tone: 'error', text: (e as Error).message };
      }
      if (g !== generation.current) return;
      setConfirmResult({ ...outcome, payload: a.payload });
      // DV7 (finding C): the proposal is consumed whatever the outcome (completed, pending
      // verification, processing, 410 expired); drop it now instead of waiting for a dashboard
      // read that fails while the bank is down. A still-pending one comes back on the next read.
      setDashboard(
        (d) => d && { ...d, approvals: d.approvals?.filter((x: AnyRecord) => x.id !== a.id) },
      );
      // DV7: a failed dashboard refresh no longer skips the conversation reload (R6: the server
      // wrote the outcome into the conversation; show it if that chat is open).
      const id = activeConversation.current;
      const [dash, chat] = await Promise.allSettled([
        refresh(g),
        id &&
          api(`conversations/${id}`).then((c) => {
            if (g === generation.current && activeConversation.current === id)
              setMessages(c.messages);
          }),
      ]);
      const failed = [dash, chat].find((r) => r.status === 'rejected');
      if (failed && g === generation.current) setError((failed.reason as Error).message);
    } catch (e) {
      if (g === generation.current) setError((e as Error).message);
    } finally {
      // U1/U4: the previous persona's confirm never releases or blocks the next one's guard.
      if (g === generation.current) setConfirming('');
    }
  }
  // PT2: prepared transfers: the section and "Prepare for later" in Transfers, and the due ones
  // in Overview's "For you to do". Send only asks for a proposal; `confirm` above stays
  // the one place that sends money.
  const prepared = usePrepared({
    api,
    customerId,
    dashboard,
    refresh,
    form: { from, to, amount, concept },
    clearForm() {
      setTo('');
      setAmount('');
      setConcept('');
    },
    conversationId,
    showTransferResult,
    goTransfers: () => show('transfers'),
  });
  // OB2: the "Worth a look" card of Overview, from `dashboard.observation`; null when none.
  const observation = useObservation({
    api,
    customerId,
    dashboard,
    refresh,
    goTransfers: () => show('transfers'),
    ask(text) {
      newConversation();
      focusComposer();
      send(text, null);
    },
  });
  // UI1 (plan 28): the Plan tab, its Overview card and the shortfall row of "For you to do".
  // A prepared transfer named there opens in Transfers as a due one does from the Overview.
  const [preparedFocus, setPreparedFocus] = useState('');
  useEffect(() => {
    const card = preparedFocus && window.document.getElementById(`prepared-${preparedFocus}`);
    if (!card) return;
    card.scrollIntoView({ block: 'center' });
    card.focus({ preventScroll: true });
    setPreparedFocus('');
  }, [preparedFocus, dashboard, tab]);
  const plan = usePlan({
    api,
    customerId,
    dashboard,
    refresh,
    active: tab === 'goals',
    goPlan: () => show('goals'),
    goOverview: () => show('overview'),
    openPrepared(id) {
      show('transfers');
      setPreparedFocus(id);
    },
  });
  // A link to the Plan tab on a server (or for a customer) without it lands on the Overview.
  useEffect(() => {
    if (tab === 'goals' && customerId && plan.known && !plan.available) {
      setTab('overview');
      window.history.replaceState(null, '', '?tab=overview');
    }
  }, [tab, customerId, plan.known, plan.available]);
  // UI2: "What the assistant may do", opened from the Assistant header and the sidebar's user
  // block. Customer only: with no customer there is no drawer and no opener.
  const controls = useAssistantControls({ api, customerId, refresh });
  const operator = current?.role === 'operator';
  // SI7b: quick replies are shown under this message only (the one the server answers to).
  const newestAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const createdPlanIds = createdPlans(messages);
  const drawerAccount =
    dashboard?.accounts?.find((a: AnyRecord) => a.id === drawerAccountId) ?? null;
  async function openCase(id: string) {
    const g = generation.current;
    try {
      const d = await api(`incidents/${id}`);
      if (g === generation.current) setSelectedCase(d);
    } catch (e) {
      // U4: drop errors from a previous persona.
      if (g === generation.current) setError((e as Error).message);
    }
  }
  async function ingest() {
    const g = generation.current;
    clearFeedback();
    setIngestBusy(true);
    try {
      const r = await api('ingestion', {});
      if (g !== generation.current) return;
      setNotice(`Index updated: ${r.documents} documents, ${r.chunks} excerpts.`);
      // U5: show the re-ingested list, not the one loaded before.
      await loadDocs(docFilter, g);
    } catch (e) {
      if (g === generation.current) setError((e as Error).message);
    } finally {
      // U4: never touch the next persona's state.
      if (g === generation.current) setIngestBusy(false);
    }
  }
  async function search() {
    const g = generation.current;
    clearFeedback();
    setSearchBusy(true);
    try {
      const result = await api('search', { query });
      if (g === generation.current) setSources(result.sources);
    } catch (e) {
      if (g === generation.current) setError((e as Error).message);
    } finally {
      if (g === generation.current) setSearchBusy(false);
    }
  }
  function filterDocs(next: typeof docFilter) {
    setDocFilter(next);
    loadDocs(next).catch((err) => setError(err.message));
  }
  async function openDocument(id: string) {
    const g = generation.current;
    try {
      const result = await api(`documents/${id}`);
      if (g !== generation.current) return;
      setCited(null);
      setDocument(result);
    } catch (e) {
      if (g === generation.current) setError((e as Error).message);
    }
  }
  // CF4-ui: people in the API's ranking (favourites, then recent, then bank order). The order is
  // frozen at the person's first dashboard load, so a toggle never moves the chips under the
  // pointer (a double click would star whoever slid into place); it changes on the next reload.
  // Only the star is live: a person is a favourite when any of their accounts is pinned. The
  // toggle is optimistic and reverts on error. CF6: a click during a save is kept (the last one
  // wins): when the save settles, one more runs if the state asked for differs from the saved one.
  // #65: a second click on the same star within 500 ms is the tail of a double click and ignored.
  const pinned: string[] = dashboard?.recipients?.favourites ?? [],
    ranked = rankRecipients(
      groupRecipients(dashboard?.contacts ?? []),
      rankBasis.current?.recipients ?? { favourites: [], recent: [] },
    ),
    isFavourite = (key: string) =>
      !!ranked.find((r) => r.key === key)?.accounts.some((a) => pinned.includes(a.id));
  async function toggleFavourite(mainId: string, favourite: boolean) {
    const g = generation.current,
      key = `${g}:${mainId}`,
      entry = favouriteWanted.current.get(key),
      now = Date.now();
    if (entry && now - entry.at < 500) return;
    // CF6 review of #75: saves for different people overlap and settle in any order, so each one
    // only rewrites this person's accounts in the current list, never the whole list.
    const mine = ranked
        .find((r) => r.accounts.some((a) => a.id === mainId))
        ?.accounts.map((a) => a.id) ?? [mainId],
      setMine = (list: string[]) =>
        setDashboard(
          (d) =>
            d && {
              ...d,
              recipients: {
                ...d.recipients,
                favourites: [
                  ...(d.recipients?.favourites ?? []).filter((id: string) => !mine.includes(id)),
                  ...list.filter((id) => mine.includes(id)),
                ],
              },
            },
        );
    setMine(favourite ? [mainId] : []);
    if (entry?.busy) {
      Object.assign(entry, { wanted: favourite, at: now });
      return;
    }
    const state = { wanted: favourite, at: now, busy: true };
    favouriteWanted.current.set(key, state);
    let saved = pinned,
      savedOn = !favourite;
    try {
      while (state.wanted !== savedOn && g === generation.current) {
        const on = state.wanted;
        for (const accountId of favouriteChange(ranked, saved, mainId, on))
          saved = (await api('recipients/favourites', { accountId, favourite: on })).favourites;
        savedOn = on;
      }
      if (g === generation.current) setMine(saved);
    } catch (e) {
      if (g !== generation.current) return;
      setMine(saved);
      setError((e as Error).message);
    } finally {
      state.busy = false;
    }
  }
  // U1: a failed session/dashboard load is shown as LoadError, not repeated as an alert.
  const loadFailed = !dashboard && !!loadError;
  const loadErrorCard = (
    <LoadError
      message={loadError}
      onRetry={retryLoad}
      busy={retrying}
      inline={!!current && tab === 'assistant'}
    />
  );
  const loading = (
    <div className="loading">
      <span className="spinner" /> Getting things ready…
    </div>
  );
  const approvals = dashboard && (
    <Approvals
      dashboard={dashboard}
      confirmResult={confirmResult}
      confirming={confirming}
      onAct={confirm}
      onDismissResult={() => setConfirmResult(null)}
      resultRef={confirmResultRef}
      // A24b (polish): the Transfers page words an unconfirmed result for a page with no one to ask.
      variant={tab === 'transfers' ? 'page' : 'chat'}
    />
  );
  return (
    <Shell
      operator={operator}
      tab={tab}
      onTab={show}
      collapsed={collapsed}
      onToggleSidebar={toggleSidebar}
      people={people}
      current={current}
      personId={personId}
      onPerson={(id) => selectPerson(id)}
      conversations={conversations}
      conversationId={conversationId}
      onOpenConversation={openConversation}
      onNewConversation={newConversation}
      plan={plan.available}
      topbarActions={
        customerId ? (
          <NotificationBell
            unread={notes?.unread ?? 0}
            items={notes?.items ?? []}
            onOpen={openNotifications}
            onGo={(l) => (l.tab === 'assistant' ? openConversation(l.conversationId) : show(l.tab))}
          />
        ) : undefined
      }
      footAction={customerId ? <ControlsButton label={false} onClick={controls.open} /> : undefined}
    >
      {controls.drawer}
      <Alerts
        error={loadFailed && error === loadError ? '' : error}
        notice={notice}
        warning={warning}
        onDismiss={(kind) =>
          (kind === 'error' ? setError : kind === 'notice' ? setNotice : setWarning)('')
        }
      />
      {!current ? (
        loadFailed ? (
          loadErrorCard
        ) : (
          loading
        )
      ) : (
        <>
          {/* B3: every view that needs the dashboard says the load failed and offers Retry. The
              library does not need it; the assistant stays open below the card, so a past
              conversation can be read with the bank down. */}
          {!dashboard && tab !== 'documents' && (loadFailed ? loadErrorCard : loading)}
          {tab === 'overview' && !operator && dashboard && (
            <>
              <Overview
                current={current}
                people={people}
                dashboard={dashboard}
                allActivity={allActivity}
                onToggleAll={() => setAllActivity((v) => !v)}
                onTab={show}
                onOpenAccount={setDrawerAccountId}
                onStartTransfer={startTransfer}
                {...movementSearch}
                recipientList={ranked}
                favourite={isFavourite}
                attention={[...prepared.attention, ...plan.attention]}
                plan={plan.overview || undefined}
                onAsk={askAssistant}
                // SI7a: both slots stay empty (Overview as before) when the dashboard has no
                // insights. Proposal rows have no category: null, so the slot adds no wrapper.
                // OB2: the observation card goes above the spending card, in the same slot.
                insights={
                  (observation || insights.summary) && (
                    <>
                      {observation}
                      {insights.summary && (
                        <SpendingCard
                          insights={insights}
                          period={shownPeriod}
                          onPeriod={selectPeriod}
                          onAsk={askMovement}
                          onAskSpending={askSpending}
                        />
                      )}
                    </>
                  )
                }
                rowExtra={
                  insights.summary
                    ? (row) =>
                        row.category ? (
                          <CategoryChip row={row} insights={insights} onAsk={() => ask(row)} />
                        ) : null
                    : undefined
                }
              />
              <AccountDrawer
                account={drawerAccount}
                isMain={drawerAccount === mainAccount(dashboard.accounts ?? [])}
                holder={current.name}
                dashboard={dashboard}
                onClose={() => setDrawerAccountId(null)}
                onTransferFrom={(id) => {
                  setDrawerAccountId(null);
                  startTransfer({ from: id });
                }}
              />
            </>
          )}
          {tab === 'assistant' && !operator && (dashboard || loadFailed) && (
            <Assistant
              conversations={conversations}
              conversationId={conversationId}
              messages={messages}
              busyId={busyId}
              failed={failed}
              text={text}
              onText={setText}
              onSend={send}
              onRetry={() => failed && send(failed.content, failed.movement ? attached : null)}
              onOpenConversation={openConversation}
              onNewConversation={newConversation}
              onOpenSource={openSource}
              messagesEndRef={messagesEnd}
              approvals={approvals}
              // SI7b: the attached movement, the insights parts of each message, one more
              // suggestion. Messages without extras render as before (null: no wrapper).
              composerExtra={
                attached && (
                  <AttachedMovement
                    movement={attached}
                    onRemove={() => {
                      setAttached(null);
                      focusComposer();
                    }}
                  />
                )
              }
              messageExtra={(m) =>
                messageExtras(m, {
                  newest: m.id === newestAssistant?.id,
                  busy: busyId !== null,
                  // The clicked reply is disabled, then replaced: focus would fall to the body.
                  onReply: (value) => {
                    send(value, null);
                    focusComposer();
                  },
                  onOpenGoal: plan.openGoal,
                  planCreated: createdPlanIds.has(m.id),
                })
              }
              suggestions={chatSuggestions(dashboard?.accounts ?? [])}
              support={conversationId ? support[conversationId] : undefined}
              onAskSupport={askSupport}
              headerExtra={<ControlsButton onClick={controls.open} />}
            />
          )}
          {tab === 'goals' && !operator && dashboard && (plan.page || loading)}
          {tab === 'transfers' && !operator && dashboard && (
            <Transfers
              dashboard={dashboard}
              people={people}
              from={from}
              to={to}
              amount={amount}
              concept={concept}
              onFrom={setFrom}
              onTo={setTo}
              onAmount={setAmount}
              onConcept={setConcept}
              busy={transferBusy}
              onSubmit={submitTransfer}
              approvals={approvals}
              prepared={prepared.section}
              formExtra={prepared.formExtra}
              recipientList={ranked}
              favourite={isFavourite}
              onToggleFavourite={toggleFavourite}
              // CF8: "Paid {date}" from the live recent list (the chip order stays frozen).
              recentPaid={(key) =>
                paidLine(
                  ranked.find((r) => r.key === key)?.accounts ?? [],
                  dashboard.recipients?.recent ?? [],
                )
              }
              // CF1-ui: a receipt link (new tab) on transfers the receipt API answers.
              rowAction={(t) =>
                hasReceipt(t) && (
                  <a
                    className="text-link receipt-link"
                    href={`/receipt/${encodeURIComponent(t.intentId)}`}
                    target="_blank"
                    rel="noopener"
                  >
                    Receipt
                  </a>
                )
              }
            />
          )}
          {tab === 'cases' && operator && dashboard && (
            <Cases
              current={current}
              dashboard={dashboard}
              people={people}
              selectedCase={selectedCase}
              caseBusy={caseBusy}
              confirmResolve={confirmResolve}
              onConfirmResolve={setConfirmResolve}
              onRefresh={refreshCases}
              onOpenCase={openCase}
              detailRef={caseDetailRef}
              filters={caseFilters}
              onFilters={setCaseFilters}
              filtered={caseResults}
              filtering={caseFiltering}
            />
          )}
          {/* TR2: operator only; the server refuses a customer on the usage routes (403). */}
          {tab === 'usage' && operator && (
            <AiUsage
              key={current.id}
              api={api}
              onOpenCase={(id) => {
                go('cases');
                openCase(id);
              }}
            />
          )}
          {tab === 'documents' && (
            <Documents
              operator={operator}
              ingestBusy={ingestBusy}
              onIngest={ingest}
              query={query}
              onQuery={setQuery}
              searchBusy={searchBusy}
              onSearch={search}
              sources={sources}
              onCloseResults={() => setSources(null)}
              onOpenSource={openSource}
              docs={docs}
              loading={docsLoading}
              products={products}
              docFilter={docFilter}
              onFilter={filterDocs}
              document={document}
              onOpenDocument={openDocument}
              cited={cited}
              readerRef={readerRef}
            />
          )}
        </>
      )}
    </Shell>
  );
}
