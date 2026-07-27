import OpenAI from 'openai';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  PAUSE_THRESHOLD_S,
  LONG_PAUSE_THRESHOLD_S,
  TRANSCRIPTION_TIMEOUT_MS,
} from './config.js';

const FALLBACK = '[Voice message — transcription unavailable]';

type WhisperWord = { word: string; start: number; end: number };

// Reconstruct transcript from word-level timestamps, injecting [pause] / [long pause]
// markers for mid-sentence gaps. Pauses immediately after sentence-ending
// punctuation (. ? !) are suppressed — those are natural sentence breaks, not
// hesitation.
function renderWithPauses(words: WhisperWord[]): string {
  if (!words.length) return '';
  const parts: string[] = [words[0].word];
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1].start - words[i].end;
    const prev = words[i].word.replace(/["'’”)\]\s]+$/, '');
    const endsSentence = /[.?!]$/.test(prev);
    let marker = '';
    if (!endsSentence) {
      if (gap >= LONG_PAUSE_THRESHOLD_S) marker = ' [long pause]';
      else if (gap >= PAUSE_THRESHOLD_S) marker = ' [pause]';
    }
    parts.push(`${marker} ${words[i + 1].word}`);
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

export async function transcribeAudio(
  audioBuffer: Buffer,
  filename = 'voice.ogg',
): Promise<string | null> {
  const apiKey =
    process.env.OPENAI_API_KEY ||
    readEnvFile(['OPENAI_API_KEY']).OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set, skipping transcription');
    return null;
  }

  try {
    // Bound the Whisper call: the SDK default is ~10min/attempt, long enough to
    // pin the (sequential) voice handler for minutes. Cap it so a slow/stalled
    // call degrades to fallback text quickly. See docs/concurrency-model.md.
    const openai = new OpenAI({
      apiKey,
      timeout: TRANSCRIPTION_TIMEOUT_MS,
      // The Telegram handler has its own outer deadline. Retrying a full
      // transcription here can exhaust that deadline and lose the update.
      maxRetries: 0,
    });
    const file = new File([audioBuffer], filename, { type: 'audio/ogg' });
    const result = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file,
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
    });
    const words = result.words;
    if (words && words.length > 0) {
      const rendered = renderWithPauses(words as WhisperWord[]);
      if (rendered) return rendered;
    }
    return result.text || null;
  } catch (err) {
    logger.error({ err }, 'Whisper transcription failed');
    return null;
  }
}

export function formatTranscript(
  transcript: string | null,
  caption?: string,
): string {
  const suffix = caption ? ` ${caption}` : '';
  if (!transcript) return `${FALLBACK}${suffix}`;
  return `[Voice: ${transcript}]${suffix}`;
}
