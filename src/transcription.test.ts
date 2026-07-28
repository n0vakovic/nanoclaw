import { channel } from 'node:diagnostics_channel';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const createMock = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class OpenAIMock {
    audio = { transcriptions: { create: createMock } };
  },
}));

vi.mock('./config.js', () => ({
  LONG_PAUSE_THRESHOLD_S: 2,
  PAUSE_THRESHOLD_S: 1,
  TRANSCRIPTION_FALLBACK_TIMEOUT_MS: 30000,
  TRANSCRIPTION_TIMEOUT_MS: 30000,
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ OPENAI_API_KEY: 'test-key' })),
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { transcribeAudioDetailed } from './transcription.js';

const diagnosticRequest = {
  origin: 'https://api.openai.com',
  path: '/v1/audio/transcriptions',
};

function successfulResponse(data: Record<string, unknown>, requestId: string) {
  return {
    withResponse: async () => {
      channel('undici:request:create').publish({
        request: diagnosticRequest,
      });
      channel('undici:request:bodySent').publish({
        request: diagnosticRequest,
      });
      channel('undici:request:headers').publish({
        request: diagnosticRequest,
        response: { statusCode: 200 },
      });
      return { data, request_id: requestId };
    },
  };
}

function timedOutResponse() {
  return {
    withResponse: async () => {
      channel('undici:request:create').publish({
        request: diagnosticRequest,
      });
      channel('undici:request:bodySent').publish({
        request: diagnosticRequest,
      });
      channel('undici:request:error').publish({
        request: diagnosticRequest,
        error: Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR',
        }),
      });
      throw Object.assign(new Error('Request timed out.'), {
        name: 'APIConnectionTimeoutError',
      });
    },
  };
}

beforeEach(() => {
  createMock.mockReset();
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
});

describe('transcription diagnostics and fallback', () => {
  it('records request phases and renders pauses for word timestamps', async () => {
    createMock.mockReturnValueOnce(
      successfulResponse(
        {
          text: 'hello there',
          duration: 4,
          words: [
            { word: 'hello', start: 0, end: 0.5 },
            { word: 'there', start: 2, end: 2.5 },
          ],
        },
        'req_word',
      ),
    );

    const outcome = await transcribeAudioDetailed(
      Buffer.from('audio'),
      'voice.oga',
      { context: 'test', audioDurationSeconds: 4 },
    );

    expect(outcome.transcript).toBe('hello [pause] there');
    expect(outcome.diagnostic.classification).toBe('word_timestamps_succeeded');
    expect(outcome.diagnostic.attempts[0]).toMatchObject({
      mode: 'whisper_word_timestamps',
      model: 'whisper-1',
      requestId: 'req_word',
      transport: {
        responseStatus: 200,
      },
    });
    expect(outcome.diagnostic.attempts[0].transport.bodySentMs).toBeDefined();
  });

  it('uses a different model and plain JSON after word timestamps time out', async () => {
    createMock
      .mockReturnValueOnce(timedOutResponse())
      .mockReturnValueOnce(
        successfulResponse({ text: 'plain recovery' }, 'req_plain'),
      );

    const outcome = await transcribeAudioDetailed(
      Buffer.from('audio'),
      'voice.oga',
      { context: 'test' },
    );

    expect(outcome.transcript).toBe('plain recovery');
    expect(outcome.diagnostic.classification).toBe(
      'word_timestamps_failed_plain_fallback_succeeded',
    );
    expect(createMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        model: 'whisper-1',
        response_format: 'verbose_json',
        timestamp_granularities: ['word'],
      }),
    );
    expect(createMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        model: 'gpt-4o-mini-transcribe',
        response_format: 'json',
      }),
    );
  });

  it('classifies body-sent/no-headers failures when OpenAI edge is reachable', async () => {
    createMock
      .mockReturnValueOnce(timedOutResponse())
      .mockReturnValueOnce(timedOutResponse());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401 }));

    const outcome = await transcribeAudioDetailed(
      Buffer.from('audio'),
      'voice.oga',
      { context: 'test' },
    );

    expect(outcome.transcript).toBeNull();
    expect(outcome.diagnostic.classification).toBe(
      'transcription_backend_no_response_after_upload',
    );
    expect(outcome.diagnostic.connectivityProbe).toMatchObject({
      reachable: true,
      status: 401,
    });
    expect(outcome.diagnostic.attempts).toHaveLength(2);
    for (const attempt of outcome.diagnostic.attempts) {
      expect(attempt.transport.bodySentMs).toBeDefined();
      expect(attempt.transport.responseHeadersMs).toBeUndefined();
      expect(attempt.transport.transportError).toMatchObject({
        name: 'AbortError',
        code: 'ABORT_ERR',
      });
    }
  });
});
