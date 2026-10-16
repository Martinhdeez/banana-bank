// VC1: a chat recording as text, through the OpenAI transcription API (the assistant's client and
// key). Server only. The audio and the transcript are never logged or stored: log lines carry the
// status and the duration, the usage row carries tokens.
import { APIError, toFile } from 'openai';
import { config } from './config';
import { HttpError } from './auth';
import { appDb } from './db';
import { log } from './http';
import { openai } from './retrieval/embeddings';
import { openaiHost, recordUsage } from './usage/record';

// What MediaRecorder produces in current browsers, and the file name the provider reads the
// format from.
export const AUDIO_TYPES: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};
export const voiceAvailable = () =>
  config.voice === 'on' && Boolean(process.env.OPENAI_API_KEY?.trim());

export async function transcribe(audio: Buffer, type: string): Promise<string> {
  const started = Date.now();
  const usage = { consumer: 'voice', model: config.voiceModel, host: openaiHost() } as const;
  // recordUsage writes only to an open DB; the first request of a fresh process may not have it.
  appDb();
  try {
    // One billed attempt per request, so the one usage row is the whole cost: no SDK retries.
    const response = await openai().audio.transcriptions.create(
      {
        file: await toFile(audio, `recording.${AUDIO_TYPES[type]}`, { type }),
        model: config.voiceModel,
      },
      { maxRetries: 0, timeout: 30000 },
    );
    const tokens = response.usage?.type === 'tokens' ? response.usage : undefined;
    recordUsage({
      ...usage,
      outcome: 'ok',
      inputTokens: tokens?.input_tokens,
      outputTokens: tokens?.output_tokens,
    });
    log('info', 'voice_ok', { status: 200, ms: Date.now() - started });
    return response.text.trim();
  } catch (error) {
    // The provider's message can quote the request: only its status is kept.
    const status = error instanceof APIError ? error.status : undefined;
    recordUsage({ ...usage, outcome: 'failed' });
    log('warn', 'voice_failed', { status, ms: Date.now() - started });
    throw new HttpError(502, 'Could not transcribe the recording.', {}, 'transcription_failed');
  }
}
