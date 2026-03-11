import OpenAI from 'openai';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const FALLBACK = '[Voice message — transcription unavailable]';

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
    const openai = new OpenAI({ apiKey });
    const file = new File([audioBuffer], filename, { type: 'audio/ogg' });
    const result = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file,
    });
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
