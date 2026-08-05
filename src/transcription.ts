import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';

import OpenAI from 'openai';

import {
  LONG_PAUSE_THRESHOLD_S,
  PAUSE_THRESHOLD_S,
  TRANSCRIPTION_FALLBACK_TIMEOUT_MS,
  TRANSCRIPTION_TIMEOUT_MS,
} from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  createDisposableDispatcher,
  type DispatcherLifecycleTrace,
} from './disposable-dispatcher.js';

const FALLBACK = '[Voice message — transcription unavailable]';
const OPENAI_ORIGIN = 'https://api.openai.com';
const TRANSCRIPTION_PATH = '/v1/audio/transcriptions';
const CONNECTIVITY_PROBE_TIMEOUT_MS = 5_000;

type WhisperWord = { word: string; start: number; end: number };
export type TranscriptionMode = 'whisper_word_timestamps' | 'gpt4o_plain_json';

type TransportTrace = {
  attemptId: string;
  startedAtMs: number;
  requestCreatedMs?: number;
  bodySentMs?: number;
  responseHeadersMs?: number;
  responseStatus?: number;
  transportErrorMs?: number;
  transportError?: Record<string, unknown>;
};

type AttemptDiagnostic = {
  attemptId: string;
  mode: TranscriptionMode;
  model: string;
  uploadFilename: string;
  timeoutMs: number;
  elapsedMs: number;
  requestId?: string | null;
  transport: Omit<TransportTrace, 'attemptId' | 'startedAtMs'>;
  dispatcher: DispatcherLifecycleTrace;
  error?: Record<string, unknown>;
};

export type TranscriptionDiagnostic = {
  audioSha256: string;
  audioBytes: number;
  audioDurationSeconds?: number;
  filename: string;
  context: string;
  classification: string;
  attempts: AttemptDiagnostic[];
  connectivityProbe?: {
    reachable: boolean;
    status?: number;
    elapsedMs: number;
    error?: Record<string, unknown>;
  };
};

export type TranscriptionOutcome = {
  transcript: string | null;
  diagnostic: TranscriptionDiagnostic;
};

export type TranscriptionOptions = {
  timeoutMs?: number;
  fallbackTimeoutMs?: number;
  enablePlainFallback?: boolean;
  primaryMode?: TranscriptionMode;
  context?: string;
  audioDurationSeconds?: number;
};

type UndiciDiagnosticMessage = {
  request?: { origin?: string; path?: string };
  response?: { statusCode?: number };
  error?: unknown;
};

const transportContext = new AsyncLocalStorage<TransportTrace>();

function elapsed(trace: TransportTrace): number {
  return Date.now() - trace.startedAtMs;
}

function describeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { value: String(error) };
  }

  const extended = error as Error & {
    code?: string | number;
    status?: number;
    type?: string;
    requestID?: string;
    cause?: unknown;
  };
  const result: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };
  if (extended.code !== undefined) result.code = extended.code;
  if (extended.status !== undefined) result.status = extended.status;
  if (extended.type !== undefined) result.type = extended.type;
  if (extended.requestID !== undefined) result.requestId = extended.requestID;
  if (extended.cause !== undefined && depth < 3) {
    result.cause = describeError(extended.cause, depth + 1);
  }
  return result;
}

function isCurrentTranscriptionRequest(
  message: UndiciDiagnosticMessage,
): boolean {
  return (
    String(message.request?.origin) === OPENAI_ORIGIN &&
    String(message.request?.path).startsWith(TRANSCRIPTION_PATH)
  );
}

function subscribeTransportPhase(
  name: string,
  update: (trace: TransportTrace, message: UndiciDiagnosticMessage) => void,
): void {
  channel(name).subscribe((rawMessage) => {
    const trace = transportContext.getStore();
    const message = rawMessage as UndiciDiagnosticMessage;
    if (!trace || !isCurrentTranscriptionRequest(message)) return;
    update(trace, message);
  });
}

// The OpenAI SDK intentionally converts fetch aborts into a generic
// APIConnectionTimeoutError and drops the underlying cause. Undici's diagnostic
// channels retain the request lifecycle, letting us distinguish upload,
// response, and transport failures without logging headers or credentials.
subscribeTransportPhase('undici:request:create', (trace) => {
  trace.requestCreatedMs = elapsed(trace);
});
subscribeTransportPhase('undici:request:bodySent', (trace) => {
  trace.bodySentMs = elapsed(trace);
});
subscribeTransportPhase('undici:request:headers', (trace, message) => {
  trace.responseHeadersMs = elapsed(trace);
  trace.responseStatus = message.response?.statusCode;
});
subscribeTransportPhase('undici:request:error', (trace, message) => {
  trace.transportErrorMs = elapsed(trace);
  trace.transportError = describeError(message.error);
});

function publicTransportTrace(
  trace: TransportTrace,
): Omit<TransportTrace, 'attemptId' | 'startedAtMs'> {
  return {
    requestCreatedMs: trace.requestCreatedMs,
    bodySentMs: trace.bodySentMs,
    responseHeadersMs: trace.responseHeadersMs,
    responseStatus: trace.responseStatus,
    transportErrorMs: trace.transportErrorMs,
    transportError: trace.transportError,
  };
}

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

async function runAttempt(
  apiKey: string,
  audioBuffer: Buffer,
  filename: string,
  mode: TranscriptionMode,
  timeoutMs: number,
  commonLog: Record<string, unknown>,
): Promise<{ transcript: string | null; diagnostic: AttemptDiagnostic }> {
  const attemptId = randomUUID();
  const startedAtMs = Date.now();
  const trace: TransportTrace = { attemptId, startedAtMs };
  const model =
    mode === 'whisper_word_timestamps' ? 'whisper-1' : 'gpt-4o-mini-transcribe';
  // Telegram commonly names Ogg voice notes `.oga`. OpenAI validates the
  // multipart filename extension and rejects that alias even though the bytes
  // and MIME type are valid Ogg audio.
  const uploadFilename = filename.replace(/\.oga$/i, '.ogg');
  const disposable = createDisposableDispatcher(startedAtMs);

  logger.info(
    { ...commonLog, attemptId, mode, model, uploadFilename, timeoutMs },
    'OpenAI transcription attempt started',
  );

  try {
    const openai = new OpenAI({
      apiKey,
      timeout: timeoutMs,
      maxRetries: 0,
      fetchOptions: { dispatcher: disposable.dispatcher },
    });
    const file = new File([audioBuffer], uploadFilename, { type: 'audio/ogg' });
    const response = await transportContext.run(trace, () => {
      const apiPromise =
        mode === 'whisper_word_timestamps'
          ? openai.audio.transcriptions.create({
              model,
              file,
              response_format: 'verbose_json',
              timestamp_granularities: ['word'],
            })
          : openai.audio.transcriptions.create({
              model,
              file,
              response_format: 'json',
            });
      return apiPromise.withResponse();
    });
    const result = response.data as {
      text?: string;
      words?: WhisperWord[];
      duration?: number;
    };
    let transcript = result.text?.trim() || null;
    if (
      mode === 'whisper_word_timestamps' &&
      result.words &&
      result.words.length > 0
    ) {
      transcript = renderWithPauses(result.words) || transcript;
    }
    await disposable.destroy();

    const diagnostic: AttemptDiagnostic = {
      attemptId,
      mode,
      model,
      uploadFilename,
      timeoutMs,
      elapsedMs: Date.now() - startedAtMs,
      requestId: response.request_id,
      transport: publicTransportTrace(trace),
      dispatcher: disposable.trace,
    };
    logger.info(
      {
        ...commonLog,
        ...diagnostic,
        transcriptChars: transcript?.length ?? 0,
        responseDurationSeconds: result.duration,
      },
      'OpenAI transcription attempt succeeded',
    );
    return { transcript, diagnostic };
  } catch (error) {
    await disposable.captureFailureSnapshot();
    await disposable.destroy();
    const diagnostic: AttemptDiagnostic = {
      attemptId,
      mode,
      model,
      uploadFilename,
      timeoutMs,
      elapsedMs: Date.now() - startedAtMs,
      transport: publicTransportTrace(trace),
      dispatcher: disposable.trace,
      error: describeError(error),
    };
    logger.error(
      { ...commonLog, ...diagnostic },
      'OpenAI transcription attempt failed',
    );
    return { transcript: null, diagnostic };
  }
}

async function probeOpenAIConnectivity(): Promise<{
  reachable: boolean;
  status?: number;
  elapsedMs: number;
  error?: Record<string, unknown>;
}> {
  const startedAtMs = Date.now();
  const disposable = createDisposableDispatcher(startedAtMs);
  try {
    // A 401 is expected: the probe deliberately sends no credential or user
    // content. Any HTTP response proves DNS/TCP/TLS and OpenAI edge reachability.
    const response = await fetch(`${OPENAI_ORIGIN}/v1/models`, {
      signal: AbortSignal.timeout(CONNECTIVITY_PROBE_TIMEOUT_MS),
      dispatcher: disposable.dispatcher,
    });
    await disposable.destroy();
    return {
      reachable: true,
      status: response.status,
      elapsedMs: Date.now() - startedAtMs,
    };
  } catch (error) {
    await disposable.destroy();
    return {
      reachable: false,
      elapsedMs: Date.now() - startedAtMs,
      error: describeError(error),
    };
  }
}

function isRetryableTransportFailure(attempt: AttemptDiagnostic): boolean {
  return (
    attempt.transport.responseHeadersMs === undefined &&
    attempt.error !== undefined
  );
}

function classifyFailure(
  attempts: AttemptDiagnostic[],
  probe: { reachable: boolean },
): string {
  // The request trace is direct evidence; the connectivity probe is only a
  // secondary observation taken after the failure. Never let a failed probe
  // turn a local pre-upload stall into the claim that OpenAI was down.
  if (
    attempts.every(
      (attempt) =>
        attempt.transport.requestCreatedMs !== undefined &&
        attempt.transport.bodySentMs === undefined &&
        attempt.transport.responseHeadersMs === undefined,
    )
  ) {
    return 'transcription_upload_stalled_before_body_sent';
  }
  if (
    attempts.every(
      (attempt) =>
        attempt.transport.bodySentMs !== undefined &&
        attempt.transport.responseHeadersMs === undefined,
    )
  ) {
    return 'transcription_backend_no_response_after_upload';
  }
  if (
    attempts.some(
      (attempt) => attempt.transport.responseHeadersMs !== undefined,
    )
  ) {
    return 'transcription_api_error_response';
  }
  if (!probe.reachable) {
    return 'transcription_transport_failure_probe_unreachable';
  }
  return 'transcription_transport_failure';
}

export async function transcribeAudioDetailed(
  audioBuffer: Buffer,
  filename = 'voice.ogg',
  options: TranscriptionOptions = {},
): Promise<TranscriptionOutcome> {
  const apiKey =
    process.env.OPENAI_API_KEY ||
    readEnvFile(['OPENAI_API_KEY']).OPENAI_API_KEY;
  const audioSha256 = createHash('sha256').update(audioBuffer).digest('hex');
  const common = {
    audioSha256,
    audioBytes: audioBuffer.length,
    audioDurationSeconds: options.audioDurationSeconds,
    filename,
    context: options.context ?? 'unspecified',
  };
  const baseDiagnostic: Omit<
    TranscriptionDiagnostic,
    'classification' | 'attempts'
  > = common;

  if (!apiKey) {
    const diagnostic: TranscriptionDiagnostic = {
      ...baseDiagnostic,
      classification: 'openai_api_key_missing',
      attempts: [],
    };
    logger.warn(diagnostic, 'OPENAI_API_KEY not set, skipping transcription');
    return { transcript: null, diagnostic };
  }

  const primaryMode = options.primaryMode ?? 'whisper_word_timestamps';
  const primary = await runAttempt(
    apiKey,
    audioBuffer,
    filename,
    primaryMode,
    options.timeoutMs ?? TRANSCRIPTION_TIMEOUT_MS,
    common,
  );
  if (primary.transcript) {
    return {
      transcript: primary.transcript,
      diagnostic: {
        ...baseDiagnostic,
        classification:
          primaryMode === 'whisper_word_timestamps'
            ? 'word_timestamps_succeeded'
            : 'plain_transcription_succeeded',
        attempts: [primary.diagnostic],
      },
    };
  }

  if (!isRetryableTransportFailure(primary.diagnostic)) {
    const connectivityProbe = await probeOpenAIConnectivity();
    const diagnostic: TranscriptionDiagnostic = {
      ...baseDiagnostic,
      classification: classifyFailure([primary.diagnostic], connectivityProbe),
      attempts: [primary.diagnostic],
      connectivityProbe,
    };
    logger.error(
      diagnostic,
      'OpenAI transcription failed with a non-retryable response',
    );
    return { transcript: null, diagnostic };
  }

  const retryMode =
    options.enablePlainFallback !== false &&
    primaryMode === 'whisper_word_timestamps'
      ? 'gpt4o_plain_json'
      : primaryMode;
  logger.warn(
    {
      ...common,
      failedAttemptId: primary.diagnostic.attemptId,
      retryMode,
    },
    'OpenAI transcription transport failed; retrying with a fresh connection',
  );
  const retry = await runAttempt(
    apiKey,
    audioBuffer,
    filename,
    retryMode,
    options.fallbackTimeoutMs ?? TRANSCRIPTION_FALLBACK_TIMEOUT_MS,
    common,
  );
  if (retry.transcript) {
    const diagnostic: TranscriptionDiagnostic = {
      ...baseDiagnostic,
      classification:
        retryMode === 'gpt4o_plain_json' && retryMode !== primaryMode
          ? 'word_timestamps_failed_plain_fallback_succeeded'
          : 'transcription_fresh_connection_retry_succeeded',
      attempts: [primary.diagnostic, retry.diagnostic],
    };
    logger.warn(
      diagnostic,
      'Fresh connection recovered failed transcription request',
    );
    return { transcript: retry.transcript, diagnostic };
  }

  const connectivityProbe = await probeOpenAIConnectivity();
  const diagnostic: TranscriptionDiagnostic = {
    ...baseDiagnostic,
    classification: classifyFailure(
      [primary.diagnostic, retry.diagnostic],
      connectivityProbe,
    ),
    attempts: [primary.diagnostic, retry.diagnostic],
    connectivityProbe,
  };
  logger.error(
    diagnostic,
    'All OpenAI transcription attempts failed with diagnostics',
  );
  return { transcript: null, diagnostic };
}

export async function transcribeAudio(
  audioBuffer: Buffer,
  filename = 'voice.ogg',
  timeoutOrOptions: number | TranscriptionOptions = {},
): Promise<string | null> {
  const options =
    typeof timeoutOrOptions === 'number'
      ? { timeoutMs: timeoutOrOptions }
      : timeoutOrOptions;
  return (await transcribeAudioDetailed(audioBuffer, filename, options))
    .transcript;
}

export function formatTranscript(
  transcript: string | null,
  caption?: string,
): string {
  const suffix = caption ? ` ${caption}` : '';
  if (!transcript) return `${FALLBACK}${suffix}`;
  return `[Voice: ${transcript}]${suffix}`;
}
