import {
  formatDate,
  outcomeTone,
  parseMessage,
  shortRefs,
  type AnyRecord,
  type Inline,
  stripBidi,
} from '../../src/ui-helpers';
import { Fragment, useEffect, useReducer, useRef, useState } from 'react';
import { Icon } from './Icon';

// VC2: voice input. The customer speaks; the recording goes to POST /api/transcribe (VC1) and the
// transcript is sent like a typed message. idle → requesting → listening → transcribing → idle,
// or error from requesting/transcribing. Events that do not fit the state change nothing.
export type VoiceState =
  | { status: 'idle'; note?: string }
  | { status: 'requesting' }
  | { status: 'listening'; elapsed: number }
  | { status: 'transcribing' }
  | { status: 'error'; message: string };
export type VoiceEvent =
  | { type: 'start' }
  | { type: 'granted' }
  | { type: 'tick'; elapsed: number }
  | { type: 'stop' }
  | { type: 'cancel' }
  | { type: 'transcribed'; text: string }
  | { type: 'failed'; message: string };
export const VOICE_IDLE: VoiceState = { status: 'idle' };
export const MAX_RECORDING_MS = 30_000;
// Calibration knobs: RMS level (0–1) that counts as speech, and the quiet time that ends a turn.
export const SPEECH_LEVEL = 0.04;
export const SILENCE_MS = 3_000; // VC3: 1.5 s sent mid-sentence on a short pause
export const MIC_BLOCKED = 'Microphone access is blocked.';
const NOTHING_HEARD = 'Nothing was heard. Try again.';
export function voiceStep(s: VoiceState, e: VoiceEvent): VoiceState {
  switch (e.type) {
    case 'start':
      return s.status === 'idle' || s.status === 'error' ? { status: 'requesting' } : s;
    case 'granted':
      return s.status === 'requesting' ? { status: 'listening', elapsed: 0 } : s;
    case 'tick':
      if (s.status !== 'listening') return s;
      return e.elapsed >= MAX_RECORDING_MS
        ? { status: 'transcribing' }
        : { status: 'listening', elapsed: e.elapsed };
    case 'stop':
      return s.status === 'listening' ? { status: 'transcribing' } : s;
    case 'cancel':
      return s.status === 'listening' ? VOICE_IDLE : s;
    case 'transcribed':
      if (s.status !== 'transcribing') return s;
      return e.text.trim() ? VOICE_IDLE : { status: 'idle', note: NOTHING_HEARD };
    case 'failed':
      return s.status === 'requesting' || s.status === 'transcribing'
        ? { status: 'error', message: e.message }
        : s;
  }
}
// The words of the live region. No clock: a second-by-second count would be read out each time.
export function voiceStatus(s: VoiceState) {
  if (s.status === 'requesting') return 'Waiting for the microphone…';
  if (s.status === 'listening') return 'Listening…';
  if (s.status === 'transcribing') return 'Transcribing…';
  if (s.status === 'error') return s.message;
  return s.note ?? '';
}
export const clock = (ms: number) => {
  const sec = Math.floor(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};
// RMS of an AnalyserNode time-domain frame (bytes centred on 128), 0–1.
export function levelOf(frame: Uint8Array) {
  let sum = 0;
  for (const b of frame) sum += ((b - 128) / 128) ** 2;
  return Math.min(1, Math.sqrt(sum / frame.length));
}
// Auto-stop on silence: only once speech was heard, after SILENCE_MS below SPEECH_LEVEL.
export type Quiet = { heard: boolean; since: number | null };
export function silence(q: Quiet, level: number, now: number): Quiet & { stop: boolean } {
  if (level >= SPEECH_LEVEL) return { heard: true, since: null, stop: false };
  if (!q.heard) return { heard: false, since: null, stop: false };
  const since = q.since ?? now;
  return { heard: true, since, stop: now - since >= SILENCE_MS };
}
export const pickMimeType = (supported: (type: string) => boolean) =>
  ['audio/webm;codecs=opus', 'audio/mp4'].find(supported) ?? '';

const BARS = 48;
type Live = {
  stream: MediaStream;
  ctx: AudioContext;
  recorder: MediaRecorder;
  raf: number;
  cap: ReturnType<typeof setTimeout>;
  discard: boolean;
};
// The recorder, the analyser and the bars. Every way out of `listening` (stop, silence, the 30 s
// cap, cancel, unmount) goes through the reducer; one effect then ends the recording and frees
// the microphone (tracks stopped, AudioContext closed).
function useVoice(onTranscript: (text: string) => void) {
  const [state, dispatch] = useReducer(voiceStep, VOICE_IDLE);
  const live = useRef<Live | null>(null);
  const mounted = useRef(true);
  const bars = useRef<HTMLSpanElement>(null);
  const latest = useRef(onTranscript);
  latest.current = onTranscript;

  function release(discard: boolean) {
    const l = live.current;
    if (!l) return;
    live.current = null;
    l.discard = discard;
    cancelAnimationFrame(l.raf);
    clearTimeout(l.cap);
    if (l.recorder.state !== 'inactive') l.recorder.stop();
    l.stream.getTracks().forEach((t) => t.stop());
    l.ctx.close().catch(() => {});
  }
  useEffect(() => {
    if (state.status !== 'listening') release(state.status !== 'transcribing');
  }, [state.status]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      release(true);
    };
  }, []);

  async function upload(blob: Blob) {
    const failed = 'We could not transcribe that. Try again.';
    try {
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });
      const body = await res.json().catch(() => ({}));
      if (!mounted.current) return;
      if (!res.ok) return dispatch({ type: 'failed', message: body.error || failed });
      const text = String(body.text ?? '').trim();
      dispatch({ type: 'transcribed', text });
      if (text) latest.current(text);
    } catch {
      if (mounted.current) dispatch({ type: 'failed', message: failed });
    }
  }

  // A double click before the button re-renders disabled asks once.
  const starting = useRef(false);
  async function start() {
    if (starting.current || live.current) return;
    starting.current = true;
    dispatch({ type: 'start' });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      starting.current = false;
      const name = (e as Error).name;
      const blocked = name === 'NotAllowedError' || name === 'SecurityError';
      return dispatch({
        type: 'failed',
        message: blocked ? MIC_BLOCKED : 'No microphone is available.',
      });
    }
    starting.current = false;
    if (!mounted.current) return stream.getTracks().forEach((t) => t.stop());
    const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const l: Live = { stream, ctx, recorder, raf: 0, cap: 0 as never, discard: false };
    recorder.onstop = () => {
      if (!l.discard) upload(new Blob(chunks, { type: recorder.mimeType || mimeType }));
    };
    recorder.start();
    live.current = l;
    dispatch({ type: 'granted' });

    const t0 = performance.now();
    // The cap also holds when the tab is hidden and animation frames stop.
    l.cap = setTimeout(
      () => dispatch({ type: 'tick', elapsed: MAX_RECORDING_MS }),
      MAX_RECORDING_MS,
    );
    const frame = new Uint8Array(analyser.fftSize);
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const history: number[] = Array(BARS).fill(0);
    let quiet: Quiet = { heard: false, since: null },
      second = 0,
      peak = 0,
      lastPush = t0;
    const loop = (now: number) => {
      if (live.current !== l) return;
      analyser.getByteTimeDomainData(frame);
      const level = levelOf(frame);
      const q = silence(quiet, level, now);
      quiet = q;
      if (q.stop) return dispatch({ type: 'stop' });
      const s = Math.floor((now - t0) / 1000);
      if (s !== second) {
        second = s;
        dispatch({ type: 'tick', elapsed: now - t0 });
      }
      // The bars scroll one step every 50 ms with the loudest level of the step; a reduced-motion
      // setting leaves them still.
      peak = Math.max(peak, level);
      if (!still && now - lastPush >= 50 && bars.current) {
        history.shift();
        history.push(peak);
        peak = 0;
        lastPush = now;
        [...bars.current.children].forEach((b, i) => {
          (b as HTMLElement).style.transform = `scaleY(${Math.min(1, 0.12 + history[i] * 5)})`;
        });
      }
      l.raf = requestAnimationFrame(loop);
    };
    l.raf = requestAnimationFrame(loop);
  }
  return { state, dispatch, start, bars };
}

function MicIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </svg>
  );
}
const date = (value: string) => formatDate(value);
function Inlines({ parts }: { parts: Inline[] }) {
  return parts.map((p, i) =>
    p.kind === 'strong' ? (
      <strong key={i}>{p.text}</strong>
    ) : p.kind === 'link' ? (
      <a key={i} href={p.href} target="_blank" rel="noopener noreferrer">
        {p.text}
      </a>
    ) : (
      p.text
    ),
  );
}
// U6: paragraphs, lists, bold and links from parsed data; React escapes every text node.
function MessageBody({ text }: { text: string }) {
  return (
    <div className="message-body">
      {/* U10: a case UUID reads as its short reference (#1R29SJ); display only. */}
      {parseMessage(shortRefs(text)).map((b, i) =>
        b.kind === 'p' ? (
          <p key={i}>
            <Inlines parts={b.inlines} />
          </p>
        ) : b.kind === 'ul' ? (
          <ul key={i}>
            {b.items.map((item, j) => (
              <li key={j}>
                <Inlines parts={item} />
              </li>
            ))}
          </ul>
        ) : (
          <ol key={i} start={b.start}>
            {b.items.map((item, j) => (
              <li key={j}>
                <Inlines parts={item} />
              </li>
            ))}
          </ol>
        ),
      )}
    </div>
  );
}

// HS1, HS2: human support from a failed turn, without the model. The server marks the stored
// answer of a turn it could not run or finish (`extras.turnFailed`, src/agent/run.ts), which also
// holds after a reload; messages stored before HS2 have no marker and offer no button.
// Fixed text, never the customer's: the model was not there to write a summary.
export const SUPPORT_SUMMARY = 'Customer asked for a person after the assistant was unavailable.';
export type SupportState = { status: 'asking' } | { status: 'error' };
// Opens the conversation's case with POST /api/actions (request_human reuses the open case of a
// conversation). The server stores the confirmation as a message (`extras.handoff`), so `reload`
// reads the conversation again and the failed turn is no longer last. `states` is read and
// written synchronously: a second click while one is in flight sends nothing.
export async function askForSupport(
  conversationId: string,
  states: Record<string, SupportState>,
  post: (path: string, body: unknown) => Promise<AnyRecord>,
  changed: () => void,
  reload: () => Promise<void>,
) {
  if (states[conversationId]?.status === 'asking') return;
  states[conversationId] = { status: 'asking' };
  changed();
  try {
    const result = await post('actions', {
      name: 'request_human',
      arguments: { summary: SUPPORT_SUMMARY },
      conversationId,
    });
    if (result.status !== 'open' || !result.incidentId) throw new Error('No case was opened.');
    await reload();
    delete states[conversationId];
  } catch {
    states[conversationId] = { status: 'error' };
  }
  changed();
}

export function Assistant({
  conversations,
  conversationId,
  messages,
  busyId,
  failed,
  text,
  onText,
  onSend,
  onRetry,
  onOpenConversation,
  onNewConversation,
  onOpenSource,
  messagesEndRef,
  approvals,
  composerExtra,
  messageExtra,
  suggestions,
  support,
  onAskSupport,
  headerExtra,
}: {
  conversations: AnyRecord[];
  conversationId: string | null;
  messages: AnyRecord[];
  busyId: string | null;
  failed: { conversationId: string | null; content: string } | null;
  text: string;
  onText(v: string): void;
  onSend(value?: string): void;
  onRetry(): void;
  onOpenConversation(id: string): void;
  onNewConversation(): void;
  onOpenSource(id: string, chunkId?: string): void;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  approvals: React.ReactNode;
  // SI7-slots (round 7, spend insights): optional extension points; nothing renders without them.
  composerExtra?: React.ReactNode;
  messageExtra?: (m: AnyRecord, isLast: boolean) => React.ReactNode;
  // FX4-c: the starter suggestions of an empty conversation; the caller's list is the only one.
  suggestions: string[];
  // HS1: the open conversation's support request, and the button's action.
  support?: SupportState;
  onAskSupport?: () => void;
  // UI2: a quiet control before "New conversation" (the opener of the assistant's controls).
  headerExtra?: React.ReactNode;
}) {
  const extra = (m: AnyRecord, i: number) => {
    const node = messageExtra?.(m, i === messages.length - 1);
    return node ? <div className="message-extra">{node}</div> : null;
  };
  // U10: the turn in flight belongs to its own conversation ('new' before it has an id).
  const busyHere = busyId !== null && busyId === (conversationId ?? 'new');
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  // U10: keep the unsent text on screen unless the server stored it before failing.
  const showFailed =
    failed && failed.conversationId === conversationId && lastUser?.content !== failed.content;
  const empty = !messages.length && !showFailed;
  // HS1, HS2: the button sits on a failed turn while it is the conversation's last message.
  const lastFailure = messages.length - 1;
  const offerSupport = onAskSupport && !!messages[lastFailure]?.extras?.turnFailed;
  // An empty conversation scrolls the proposals panel under the greeting so the panel never
  // pushes it out of view; with messages it stays fixed above the composer (U2).
  const panel = approvals && <div className="chat-approvals">{approvals}</div>;
  // VC2: the button shows only when the session says voice works (a customer with a model key)
  // and the browser can record.
  const [voice, setVoice] = useState(false);
  useEffect(() => {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;
    fetch('/api/session', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => setVoice(s?.voice === true))
      .catch(() => {});
  }, []);
  const form = useRef<HTMLFormElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  // The transcript joins a typed draft and is sent by the form, the same path as pressing Send.
  const pending = useRef<string | null>(null);
  const mic = useVoice((said) => {
    const next = text.trim() ? `${text.trim()} ${said}` : said;
    if (next === text) return form.current?.requestSubmit();
    pending.current = next;
    onText(next);
  });
  useEffect(() => {
    if (pending.current === null || pending.current !== text) return;
    pending.current = null;
    form.current?.requestSubmit();
  }, [text]);
  const vs = mic.state.status;
  const recording = vs === 'listening' || vs === 'transcribing';
  // Focus follows the control: the stop button while listening, the textarea after.
  const wasRecording = useRef(false);
  useEffect(() => {
    if (vs === 'listening') toggle.current?.focus();
    else if (wasRecording.current && !recording) textarea.current?.focus();
    wasRecording.current = recording;
  }, [vs]);
  const micButton = voice && (
    <button
      ref={toggle}
      type="button"
      className={`voice-toggle${vs === 'listening' ? ' on' : ''}`}
      aria-label="Voice input"
      aria-pressed={vs === 'listening'}
      title={vs === 'listening' ? 'Stop and send' : 'Speak your message'}
      disabled={vs === 'listening' ? false : busyId !== null || (vs !== 'idle' && vs !== 'error')}
      onClick={() => (vs === 'listening' ? mic.dispatch({ type: 'stop' }) : mic.start())}
    >
      {vs === 'listening' ? (
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
        </svg>
      ) : (
        <MicIcon />
      )}
    </button>
  );
  return (
    <div className="chat-layout">
      {/* PL1 (round 6): the view's h1, for screen readers; the header shows the picker. */}
      <h1 className="sr-only">Assistant</h1>
      <div className="chat-header">
        <div className="chat-header-main">
          <span className="assistant-avatar" aria-hidden="true">
            <Icon name="sparkle" size={16} />
          </span>
          <div className="chat-title">
            {/* U10: on phones the sidebar list is hidden, so this is the single picker. */}
            <span className="conversation-picker">
              <select
                aria-label="Conversation"
                value={conversationId || ''}
                onChange={(e) => onOpenConversation(e.target.value)}
              >
                <option value="">New conversation</option>
                {conversations.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
              <Icon name="chevron" size={10} />
            </span>
            <small>
              <i className="live-dot" /> Banana assistant · answers from your accounts and bank
              documents
            </small>
          </div>
        </div>
        <div className="chat-header-actions">
          {headerExtra}
          <button type="button" className="secondary-button" onClick={onNewConversation}>
            + New conversation
          </button>
        </div>
      </div>
      {/* U7: new messages and "Checking…" are announced to screen readers. */}
      <div className="messages" role="log" aria-live="polite">
        <div className="thread">
          {empty && (
            <div className="chat-empty">
              <Icon name="sparkle" size={28} />
              <h2>What do you need today?</h2>
              <p>Ask about your accounts, a fee or a transfer.</p>
            </div>
          )}
          {empty && panel}
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div className="message user" key={m.id || i}>
                <div className="bubble">
                  {m.content}
                  {extra(m, i)}
                </div>
                <small>{date(m.created_at)}</small>
              </div>
            ) : (
              <Fragment key={m.id || i}>
                <div className={`message ${m.role}`}>
                  <span className="message-avatar" aria-hidden="true">
                    <Icon name="sparkle" size={15} />
                  </span>
                  <div className="bubble">
                    {/* R6: transfer outcomes are messages the server stored in this chat. */}
                    {outcomeTone(m.run_id) ? (
                      <p className={`outcome ${outcomeTone(m.run_id)}`} role="status">
                        {stripBidi(String(m.content))}
                      </p>
                    ) : (
                      <MessageBody text={String(m.content)} />
                    )}
                    {m.sources?.length > 0 && (
                      <div className="citations" aria-label="Sources">
                        <span>Sources</span>
                        {m.sources.map((s: AnyRecord) => (
                          <button
                            type="button"
                            key={s.documentId}
                            className="subtle-tag"
                            title={`${s.documentId} · valid from ${s.validFrom}${s.validTo ? ` to ${s.validTo}` : ''}`}
                            onClick={() => onOpenSource(s.documentId, s.id)}
                          >
                            <Icon name="document" size={12} />
                            {s.title} · v{s.version}
                          </button>
                        ))}
                      </div>
                    )}
                    {extra(m, i)}
                    {offerSupport && i === lastFailure && (
                      <div className="support-ask">
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={support?.status === 'asking'}
                          aria-busy={support?.status === 'asking'}
                          onClick={onAskSupport}
                        >
                          {support?.status === 'asking' ? 'Asking…' : 'Ask for human support'}
                        </button>
                        {support?.status === 'error' && (
                          <p>We could not open a support request. Try again.</p>
                        )}
                      </div>
                    )}
                    <small>{date(m.created_at)}</small>
                  </div>
                </div>
              </Fragment>
            ),
          )}
          {showFailed && (
            <div className="message user failed">
              <div className="bubble">{failed.content}</div>
              <div className="failed-note">
                Not sent.
                <button type="button" className="text-link" onClick={onRetry}>
                  Retry
                </button>
              </div>
            </div>
          )}
          {busyHere && (
            <div className="message assistant">
              <span className="message-avatar" aria-hidden="true">
                <Icon name="sparkle" size={15} />
              </span>
              <div className="thinking">
                <i />
                <i />
                <i />
                <span>Checking…</span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>
      {!empty && panel}
      <form
        ref={form}
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
      >
        {!messages.length && (
          <div className="suggestions">
            {suggestions.map((s) => (
              <button
                type="button"
                key={s}
                disabled={busyId !== null || recording}
                onClick={() => onSend(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="composer-box">
          {composerExtra && (
            <div className="composer-extra" data-testid="composer-extra">
              {composerExtra}
            </div>
          )}
          {recording ? (
            <div className="voice-bar">
              {vs === 'listening' ? (
                <>
                  <button
                    type="button"
                    className="voice-cancel"
                    aria-label="Cancel recording"
                    title="Cancel"
                    onClick={() => mic.dispatch({ type: 'cancel' })}
                  >
                    <Icon name="close" size={14} />
                  </button>
                  <span className="voice-pulse" aria-hidden="true">
                    <MicIcon size={15} />
                  </span>
                  <span className="voice-level" ref={mic.bars} aria-hidden="true">
                    {Array.from({ length: BARS }, (_, i) => (
                      <i key={i} />
                    ))}
                  </span>
                  <span className="voice-clock">
                    {clock(mic.state.status === 'listening' ? mic.state.elapsed : 0)}
                  </span>
                </>
              ) : (
                <span className="voice-shimmer" aria-hidden="true">
                  Transcribing…
                </span>
              )}
              {vs === 'listening' && micButton}
            </div>
          ) : (
            <textarea
              ref={textarea}
              aria-label="Message the assistant"
              placeholder="Ask about your money, a fee or a transfer…"
              value={text}
              onChange={(e) => onText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  onSend();
                }
              }}
              rows={1}
            />
          )}
          {voice && (
            <p
              className={`voice-status${recording ? ' sr-only' : ''}${vs === 'error' ? ' voice-error' : ''}`}
              role="status"
            >
              {voiceStatus(mic.state)}
            </p>
          )}
          <div className="composer-row" hidden={recording}>
            <span className="context-chip">
              <i className="live-dot" /> Uses your accounts and bank documents
            </span>
            <span className="composer-actions">
              <span className="composer-hint">
                {busyId !== null && !busyHere
                  ? 'Waiting for the reply in another conversation'
                  : 'Enter to send · Shift + Enter for a new line'}
              </span>
              {!recording && micButton}
              <button aria-label="Send message" disabled={busyId !== null || !text.trim()}>
                <Icon name="arrow" size={15} />
              </button>
            </span>
          </div>
        </div>
        <p className="chat-footnote">
          AI assistant · Check important details before taking action.
        </p>
      </form>
    </div>
  );
}
