import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';

import { logger } from './logger.js';
import { fetchWithTimeout } from './timeout.js';
import {
  createDisposableDispatcher,
  type DispatcherLifecycleTrace,
} from './disposable-dispatcher.js';

const ELEVENLABS_ORIGIN = 'https://api.elevenlabs.io';
const ELEVENLABS_TTS_PATH = '/v1/text-to-speech/';

type TransportTrace = {
  startedAtMs: number;
  requestCreatedMs?: number;
  bodySentMs?: number;
  responseHeadersMs?: number;
  responseStatus?: number;
  responseBodyMs?: number;
  transportErrorMs?: number;
  transportError?: Record<string, unknown>;
};

type UndiciDiagnosticMessage = {
  request?: { origin?: string; path?: string };
  response?: { statusCode?: number };
  error?: unknown;
};

export type TtsAttemptDiagnostic = {
  attemptId: string;
  voiceId: string;
  modelId: string;
  textChars: number;
  timeoutMs: number;
  elapsedMs: number;
  classification: string;
  requestId?: string | null;
  transport: Omit<TransportTrace, 'startedAtMs'>;
  dispatcher: DispatcherLifecycleTrace;
  error?: Record<string, unknown>;
};

export type TtsDiagnostic = TtsAttemptDiagnostic & {
  attempts?: TtsAttemptDiagnostic[];
};

export type TtsOutcome = {
  audio: Buffer | null;
  diagnostic: TtsDiagnostic;
  responseBody?: string;
};

const transportContext = new AsyncLocalStorage<TransportTrace>();

function elapsed(trace: TransportTrace): number {
  return Date.now() - trace.startedAtMs;
}

function describeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { value: String(error) };
  const extended = error as Error & {
    code?: string | number;
    status?: number;
    cause?: unknown;
  };
  const result: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };
  if (extended.code !== undefined) result.code = extended.code;
  if (extended.status !== undefined) result.status = extended.status;
  if (extended.cause !== undefined && depth < 3) {
    result.cause = describeError(extended.cause, depth + 1);
  }
  return result;
}

function isCurrentTtsRequest(message: UndiciDiagnosticMessage): boolean {
  return (
    String(message.request?.origin) === ELEVENLABS_ORIGIN &&
    String(message.request?.path).startsWith(ELEVENLABS_TTS_PATH)
  );
}

function subscribeTransportPhase(
  name: string,
  update: (trace: TransportTrace, message: UndiciDiagnosticMessage) => void,
): void {
  channel(name).subscribe((rawMessage) => {
    const trace = transportContext.getStore();
    const message = rawMessage as UndiciDiagnosticMessage;
    if (!trace || !isCurrentTtsRequest(message)) return;
    update(trace, message);
  });
}

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
): Omit<TransportTrace, 'startedAtMs'> {
  return {
    requestCreatedMs: trace.requestCreatedMs,
    bodySentMs: trace.bodySentMs,
    responseHeadersMs: trace.responseHeadersMs,
    responseStatus: trace.responseStatus,
    responseBodyMs: trace.responseBodyMs,
    transportErrorMs: trace.transportErrorMs,
    transportError: trace.transportError,
  };
}

function classifyFailure(trace: TransportTrace, responseStatus?: number) {
  if (
    trace.requestCreatedMs !== undefined &&
    trace.bodySentMs === undefined &&
    trace.responseHeadersMs === undefined
  ) {
    return 'tts_upload_stalled_before_body_sent';
  }
  if (trace.bodySentMs !== undefined && trace.responseHeadersMs === undefined) {
    return 'tts_backend_no_response_after_upload';
  }
  if (responseStatus !== undefined && responseStatus >= 400) {
    return 'tts_api_error_response';
  }
  if (
    trace.responseHeadersMs !== undefined &&
    trace.responseBodyMs === undefined
  ) {
    return 'tts_response_body_failed';
  }
  if (trace.requestCreatedMs === undefined) return 'tts_request_not_created';
  return 'tts_transport_failure';
}

async function runSynthesisAttempt(options: {
  apiKey: string;
  text: string;
  voiceId: string;
  modelId: string;
  timeoutMs: number;
  context?: Record<string, unknown>;
}): Promise<TtsOutcome> {
  const { apiKey, text, voiceId, modelId, timeoutMs } = options;
  const attemptId = randomUUID();
  const startedAtMs = Date.now();
  const trace: TransportTrace = { startedAtMs };
  const disposable = createDisposableDispatcher(startedAtMs);
  const common = {
    ...options.context,
    attemptId,
    voiceId,
    modelId,
    textChars: text.length,
    timeoutMs,
  };
  logger.info(common, 'ElevenLabs TTS attempt started');

  try {
    const response = await transportContext.run(trace, () =>
      fetchWithTimeout(
        `${ELEVENLABS_ORIGIN}${ELEVENLABS_TTS_PATH}${voiceId}`,
        timeoutMs,
        {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text,
            model_id: modelId,
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
          dispatcher: disposable.dispatcher,
        },
      ),
    );
    trace.responseHeadersMs ??= elapsed(trace);
    trace.responseStatus ??= response.status;
    const requestId =
      response.headers.get('request-id') ||
      response.headers.get('x-request-id');

    if (!response.ok) {
      const responseBody = await response.text();
      trace.responseBodyMs = elapsed(trace);
      await disposable.destroy();
      const diagnostic: TtsAttemptDiagnostic = {
        ...common,
        elapsedMs: elapsed(trace),
        classification: 'tts_api_error_response',
        requestId,
        transport: publicTransportTrace(trace),
        dispatcher: disposable.trace,
      };
      logger.error(
        { ...options.context, ...diagnostic },
        'ElevenLabs TTS attempt failed',
      );
      return { audio: null, diagnostic, responseBody };
    }

    const audio = Buffer.from(await response.arrayBuffer());
    trace.responseBodyMs = elapsed(trace);
    await disposable.destroy();
    const diagnostic: TtsAttemptDiagnostic = {
      ...common,
      elapsedMs: elapsed(trace),
      classification: audio.length > 0 ? 'tts_succeeded' : 'tts_empty_response',
      requestId,
      transport: publicTransportTrace(trace),
      dispatcher: disposable.trace,
    };
    if (audio.length === 0) {
      logger.error(
        { ...options.context, ...diagnostic },
        'ElevenLabs TTS attempt failed',
      );
      return { audio: null, diagnostic };
    }
    logger.info(
      { ...options.context, ...diagnostic, audioBytes: audio.length },
      'ElevenLabs TTS attempt succeeded',
    );
    return { audio, diagnostic };
  } catch (error) {
    await disposable.captureFailureSnapshot();
    await disposable.destroy();
    const diagnostic: TtsAttemptDiagnostic = {
      ...common,
      elapsedMs: elapsed(trace),
      classification: classifyFailure(trace, trace.responseStatus),
      transport: publicTransportTrace(trace),
      dispatcher: disposable.trace,
      error: describeError(error),
    };
    logger.error(
      { ...options.context, ...diagnostic },
      'ElevenLabs TTS attempt failed',
    );
    return { audio: null, diagnostic };
  }
}

function isRetryableTransportFailure(
  diagnostic: TtsAttemptDiagnostic,
): boolean {
  return (
    diagnostic.classification !== 'tts_api_error_response' &&
    diagnostic.error !== undefined
  );
}

export async function synthesizeSpeechDetailed(options: {
  apiKey: string;
  text: string;
  voiceId: string;
  modelId: string;
  timeoutMs: number;
  context?: Record<string, unknown>;
}): Promise<TtsOutcome> {
  const primary = await runSynthesisAttempt(options);
  if (primary.audio || !isRetryableTransportFailure(primary.diagnostic)) {
    return primary;
  }

  logger.warn(
    {
      ...options.context,
      failedAttemptId: primary.diagnostic.attemptId,
      failedClassification: primary.diagnostic.classification,
    },
    'ElevenLabs TTS transport failed; retrying with a fresh connection',
  );
  const retry = await runSynthesisAttempt(options);
  const diagnostic: TtsDiagnostic = {
    ...retry.diagnostic,
    classification: retry.audio
      ? 'tts_fresh_connection_retry_succeeded'
      : retry.diagnostic.classification,
    attempts: [primary.diagnostic, retry.diagnostic],
  };
  if (retry.audio) {
    logger.warn(
      { ...options.context, ...diagnostic },
      'Fresh connection recovered failed ElevenLabs TTS request',
    );
  }
  return { ...retry, diagnostic };
}
