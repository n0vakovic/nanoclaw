import { channel } from 'node:diagnostics_channel';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('./logger.js', () => ({ logger: loggerMock }));

import { synthesizeSpeechDetailed } from './tts.js';

const diagnosticRequest = {
  origin: 'https://api.elevenlabs.io',
  path: '/v1/text-to-speech/voice-1',
};

function publishRequestPhases(options: {
  bodySent?: boolean;
  headers?: number;
  error?: Error;
}) {
  channel('undici:request:create').publish({ request: diagnosticRequest });
  if (options.bodySent) {
    channel('undici:request:bodySent').publish({ request: diagnosticRequest });
  }
  if (options.headers !== undefined) {
    channel('undici:request:headers').publish({
      request: diagnosticRequest,
      response: { statusCode: options.headers },
    });
  }
  if (options.error) {
    channel('undici:request:error').publish({
      request: diagnosticRequest,
      error: options.error,
    });
  }
}

const baseOptions = {
  apiKey: 'secret-test-key',
  text: 'A short line.',
  voiceId: 'voice-1',
  modelId: 'eleven_turbo_v2_5',
  timeoutMs: 30_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('ElevenLabs TTS diagnostics', () => {
  it('records request phases, request ID, and audio bytes on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        publishRequestPhases({ bodySent: true, headers: 200 });
        return new Response(Buffer.from('mp3 bytes'), {
          status: 200,
          headers: { 'request-id': 'eleven-request-1' },
        });
      }),
    );

    const outcome = await synthesizeSpeechDetailed(baseOptions);

    expect(outcome.audio).toEqual(Buffer.from('mp3 bytes'));
    expect(outcome.diagnostic).toMatchObject({
      classification: 'tts_succeeded',
      requestId: 'eleven-request-1',
      textChars: 13,
      transport: { responseStatus: 200 },
    });
    expect(outcome.diagnostic.transport.requestCreatedMs).toBeDefined();
    expect(outcome.diagnostic.transport.bodySentMs).toBeDefined();
    expect(outcome.diagnostic.transport.responseHeadersMs).toBeDefined();
    expect(outcome.diagnostic.transport.responseBodyMs).toBeDefined();
    expect(outcome.diagnostic.dispatcher).toMatchObject({
      strategy: 'disposable_per_attempt',
      destroyStartedMs: expect.any(Number),
      destroyCompletedMs: expect.any(Number),
    });
  });

  it('classifies a stall before the request body was sent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const error = Object.assign(new Error('The operation was aborted'), {
          name: 'TimeoutError',
          code: 23,
        });
        publishRequestPhases({ error });
        throw error;
      }),
    );

    const outcome = await synthesizeSpeechDetailed(baseOptions);

    expect(outcome.audio).toBeNull();
    expect(outcome.diagnostic.classification).toBe(
      'tts_upload_stalled_before_body_sent',
    );
    expect(outcome.diagnostic.transport.requestCreatedMs).toBeDefined();
    expect(outcome.diagnostic.transport.bodySentMs).toBeUndefined();
    expect(outcome.diagnostic.transport.responseHeadersMs).toBeUndefined();
    expect(outcome.diagnostic.error).toMatchObject({
      name: 'TimeoutError',
      code: 23,
    });
    expect(outcome.diagnostic.attempts).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    const firstDispatcher = vi.mocked(fetch).mock.calls[0][1]?.dispatcher;
    const retryDispatcher = vi.mocked(fetch).mock.calls[1][1]?.dispatcher;
    expect(firstDispatcher).toBeDefined();
    expect(retryDispatcher).toBeDefined();
    expect(retryDispatcher).not.toBe(firstDispatcher);
  });

  it('classifies no response after a completed upload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const error = new Error('timed out');
        publishRequestPhases({ bodySent: true, error });
        throw error;
      }),
    );

    const outcome = await synthesizeSpeechDetailed(baseOptions);

    expect(outcome.audio).toBeNull();
    expect(outcome.diagnostic.classification).toBe(
      'tts_backend_no_response_after_upload',
    );
    expect(outcome.diagnostic.attempts).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('recovers one transport failure over a fresh dispatcher', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(async () => {
          const error = new Error('timed out');
          publishRequestPhases({ bodySent: true, error });
          throw error;
        })
        .mockImplementationOnce(async () => {
          publishRequestPhases({ bodySent: true, headers: 200 });
          return new Response(Buffer.from('recovered mp3'), { status: 200 });
        }),
    );

    const outcome = await synthesizeSpeechDetailed(baseOptions);

    expect(outcome.audio).toEqual(Buffer.from('recovered mp3'));
    expect(outcome.diagnostic.classification).toBe(
      'tts_fresh_connection_retry_succeeded',
    );
    expect(outcome.diagnostic.attempts).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[1][1]?.dispatcher).not.toBe(
      vi.mocked(fetch).mock.calls[0][1]?.dispatcher,
    );
  });

  it('preserves API response status, request ID, and error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        publishRequestPhases({ bodySent: true, headers: 429 });
        return new Response('{"detail":"rate limited"}', {
          status: 429,
          headers: { 'request-id': 'eleven-request-429' },
        });
      }),
    );

    const outcome = await synthesizeSpeechDetailed(baseOptions);

    expect(outcome.audio).toBeNull();
    expect(outcome.responseBody).toBe('{"detail":"rate limited"}');
    expect(outcome.diagnostic).toMatchObject({
      classification: 'tts_api_error_response',
      requestId: 'eleven-request-429',
      transport: { responseStatus: 429 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(outcome.diagnostic.attempts).toBeUndefined();
  });
});
