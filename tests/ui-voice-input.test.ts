// VC2: voice input in the chat composer. The state machine, the silence auto-stop, the clock,
// the recorder's format and the usage labels; no browser, no microphone, no provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RECORDING_MS,
  SILENCE_MS,
  SPEECH_LEVEL,
  VOICE_IDLE,
  clock,
  levelOf,
  pickMimeType,
  silence,
  voiceStatus,
  voiceStep,
  type VoiceState,
} from '../app/_components/Assistant';
import { consumerLabel } from '../app/_components/AiUsage';
import { byAreaTree } from '../app/_components/UsageSankey';

const run = (events: Parameters<typeof voiceStep>[1][], from: VoiceState = VOICE_IDLE) =>
  events.reduce(voiceStep, from);

test('a click asks for the microphone, then listens, stops and transcribes', () => {
  assert.equal(run([{ type: 'start' }]).status, 'requesting');
  assert.equal(run([{ type: 'start' }, { type: 'granted' }]).status, 'listening');
  const stopped = run([{ type: 'start' }, { type: 'granted' }, { type: 'stop' }]);
  assert.equal(stopped.status, 'transcribing');
  assert.equal(voiceStatus(stopped), 'Transcribing…');
  const done = voiceStep(stopped, { type: 'transcribed', text: 'How much did I spend?' });
  assert.deepEqual(done, VOICE_IDLE);
});

test('an empty transcript leaves a short note and nothing else', () => {
  const s = run([
    { type: 'start' },
    { type: 'granted' },
    { type: 'stop' },
    { type: 'transcribed', text: '  ' },
  ]);
  assert.equal(s.status, 'idle');
  assert.ok(voiceStatus(s).length > 0, 'the customer is told nothing was heard');
});

test("the server's sentence is shown on error; a blocked microphone says so", () => {
  const s = run([
    { type: 'start' },
    { type: 'granted' },
    { type: 'stop' },
    { type: 'failed', message: 'Recording too long.' },
  ]);
  assert.equal(s.status, 'error');
  assert.equal(voiceStatus(s), 'Recording too long.');
  const denied = run([
    { type: 'start' },
    { type: 'failed', message: 'Microphone access is blocked.' },
  ]);
  assert.equal(voiceStatus(denied), 'Microphone access is blocked.');
  // From an error a new click starts again.
  assert.equal(voiceStep(denied, { type: 'start' }).status, 'requesting');
});

test('cancel discards the recording: back to idle, never transcribing', () => {
  const s = run([{ type: 'start' }, { type: 'granted' }, { type: 'cancel' }]);
  assert.deepEqual(s, VOICE_IDLE);
  // A late result of a cancelled recording changes nothing.
  assert.deepEqual(voiceStep(s, { type: 'transcribed', text: 'late' }), VOICE_IDLE);
});

test('the recording stops itself at 30 seconds', () => {
  assert.equal(MAX_RECORDING_MS, 30_000);
  const listening = run([{ type: 'start' }, { type: 'granted' }]);
  assert.equal(voiceStep(listening, { type: 'tick', elapsed: 29_999 }).status, 'listening');
  assert.equal(voiceStep(listening, { type: 'tick', elapsed: 30_000 }).status, 'transcribing');
});

test('a second start while listening or transcribing does nothing', () => {
  const listening = run([{ type: 'start' }, { type: 'granted' }]);
  assert.equal(voiceStep(listening, { type: 'start' }), listening);
  const transcribing = voiceStep(listening, { type: 'stop' });
  assert.equal(voiceStep(transcribing, { type: 'start' }), transcribing);
});

test('the elapsed time reads m:ss', () => {
  assert.equal(clock(0), '0:00');
  assert.equal(clock(4_900), '0:04');
  assert.equal(clock(30_000), '0:30');
  assert.equal(clock(65_000), '1:05');
});

test('silence stops only after speech, once the level stayed low for the window', () => {
  const quiet = SPEECH_LEVEL / 4,
    loud = SPEECH_LEVEL * 2;
  let q = { heard: false, since: null as number | null, stop: false };
  // Silence before any speech never stops.
  for (let t = 0; t <= 5_000; t += 100) {
    q = silence(q, quiet, t);
    assert.equal(q.stop, false);
  }
  q = silence(q, loud, 5_100);
  assert.equal(q.heard, true);
  q = silence(q, quiet, 5_200);
  assert.equal(silence(q, quiet, 5_200 + SILENCE_MS - 1).stop, false);
  // Speech in the window starts it again.
  const resumed = silence(silence(q, loud, 6_000), quiet, 6_100);
  assert.equal(silence(resumed, quiet, 5_200 + SILENCE_MS).stop, false);
  assert.equal(silence(q, quiet, 5_200 + SILENCE_MS).stop, true);
  assert.equal(SILENCE_MS, 3_000); // VC3: wait 3 s of quiet before sending
});

test('the level of a silent frame is 0 and of a full-scale square wave is 1', () => {
  assert.equal(levelOf(new Uint8Array(64).fill(128)), 0);
  const square = Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 0 : 255));
  assert.ok(levelOf(square) > 0.99);
});

test('the recorder uses the first supported of webm/opus and mp4', () => {
  assert.equal(
    pickMimeType(() => true),
    'audio/webm;codecs=opus',
  );
  assert.equal(
    pickMimeType((t) => t === 'audio/mp4'),
    'audio/mp4',
  );
  assert.equal(
    pickMimeType(() => false),
    '',
  );
});

test("the voice consumer reads 'Voice (transcription)' under Customers' assistant", () => {
  assert.equal(consumerLabel('voice'), 'Voice (transcription)');
  const t = { requests: 2, costNanoUsd: 500, providerNanoUsd: 0, unpricedRequests: 0 };
  const tree = byAreaTree({ totals: t, byConsumer: [{ consumer: 'voice', ...t }] });
  const area = tree.children!.find((c) => c.label === "Customers' assistant")!;
  assert.deepEqual(
    area.children!.map((c) => c.label),
    ['Voice (transcription)'],
  );
  assert.equal(
    tree.children!.some((c) => c.label === 'Other'),
    false,
  );
});
