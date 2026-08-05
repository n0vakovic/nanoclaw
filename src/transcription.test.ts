import { channel } from 'node:diagnostics_channel';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const createMock = vi.hoisted(() => vi.fn());
const openAIConstructorMock = vi.hoisted(() => vi.fn());
const undiciFetchMock = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: class OpenAIMock {
    constructor(options: unknown) {
      openAIConstructorMock(options);
    }
    audio = { transcriptions: { create: createMock } };
  },
}));
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: undiciFetchMock,
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

function uploadStalledResponse() {
  return {
    withResponse: async () => {
      channel('undici:request:create').publish({
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

function apiErrorResponse(status: number) {
  return {
    withResponse: async () => {
      channel('undici:request:create').publish({ request: diagnosticRequest });
      channel('undici:request:bodySent').publish({
        request: diagnosticRequest,
      });
      channel('undici:request:headers').publish({
        request: diagnosticRequest,
        response: { statusCode: status },
      });
      throw Object.assign(new Error(`HTTP ${status}`), {
        name: 'APIStatusError',
        status,
      });
    },
  };
}

beforeEach(() => {
  createMock.mockReset();
  openAIConstructorMock.mockReset();
  undiciFetchMock.mockReset();
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
      uploadFilename: 'voice.ogg',
      requestId: 'req_word',
      transport: {
        responseStatus: 200,
      },
    });
    expect(outcome.diagnostic.attempts[0].transport.bodySentMs).toBeDefined();
    expect(outcome.diagnostic.attempts[0].dispatcher).toMatchObject({
      strategy: 'disposable_per_attempt',
      destroyStartedMs: expect.any(Number),
      destroyCompletedMs: expect.any(Number),
    });
    expect(openAIConstructorMock.mock.calls[0][0].fetch).toBe(undiciFetchMock);
    const uploadedFile = createMock.mock.calls[0][0].file as File;
    expect(uploadedFile.name).toBe('voice.ogg');
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
    const firstDispatcher =
      openAIConstructorMock.mock.calls[0][0].fetchOptions.dispatcher;
    const retryDispatcher =
      openAIConstructorMock.mock.calls[1][0].fetchOptions.dispatcher;
    expect(retryDispatcher).not.toBe(firstDispatcher);
  });

  it('retries plain transcription once without changing models', async () => {
    createMock
      .mockReturnValueOnce(uploadStalledResponse())
      .mockReturnValueOnce(
        successfulResponse({ text: 'fresh recovery' }, 'req_fresh'),
      );

    const outcome = await transcribeAudioDetailed(
      Buffer.from('audio'),
      'voice.oga',
      {
        context: 'test',
        primaryMode: 'gpt4o_plain_json',
        enablePlainFallback: false,
      },
    );

    expect(outcome.transcript).toBe('fresh recovery');
    expect(outcome.diagnostic.classification).toBe(
      'transcription_fresh_connection_retry_succeeded',
    );
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[0][0].model).toBe('gpt-4o-mini-transcribe');
    expect(createMock.mock.calls[1][0].model).toBe('gpt-4o-mini-transcribe');
    expect(
      openAIConstructorMock.mock.calls[1][0].fetchOptions.dispatcher,
    ).not.toBe(openAIConstructorMock.mock.calls[0][0].fetchOptions.dispatcher);
  });

  it('does not retry explicit OpenAI API errors', async () => {
    createMock.mockReturnValueOnce(apiErrorResponse(429));
    undiciFetchMock.mockResolvedValue({ status: 401 });

    const outcome = await transcribeAudioDetailed(
      Buffer.from('audio'),
      'voice.oga',
      { context: 'test' },
    );

    expect(outcome.transcript).toBeNull();
    expect(outcome.diagnostic.classification).toBe(
      'transcription_api_error_response',
    );
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(outcome.diagnostic.attempts).toHaveLength(1);
  });

  it('classifies body-sent/no-headers failures when OpenAI edge is reachable', async () => {
    createMock
      .mockReturnValueOnce(timedOutResponse())
      .mockReturnValueOnce(timedOutResponse());
    undiciFetchMock.mockResolvedValue({ status: 401 });

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

  it('classifies a pre-upload stall from request phases even when the later probe fails', async () => {
    createMock
      .mockReturnValueOnce(uploadStalledResponse())
      .mockReturnValueOnce(uploadStalledResponse());
    undiciFetchMock.mockRejectedValue(
      Object.assign(new Error('probe timed out'), {
        name: 'TimeoutError',
        code: 23,
      }),
    );

    const outcome = await transcribeAudioDetailed(
      Buffer.from('audio'),
      'voice.oga',
      { context: 'test' },
    );

    expect(outcome.transcript).toBeNull();
    expect(outcome.diagnostic.classification).toBe(
      'transcription_upload_stalled_before_body_sent',
    );
    expect(outcome.diagnostic.connectivityProbe).toMatchObject({
      reachable: false,
    });
    for (const attempt of outcome.diagnostic.attempts) {
      expect(attempt.transport.requestCreatedMs).toBeDefined();
      expect(attempt.transport.bodySentMs).toBeUndefined();
      expect(attempt.transport.responseHeadersMs).toBeUndefined();
    }
  });
});
