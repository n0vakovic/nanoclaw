import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

const fsMock = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));
vi.mock('fs', () => ({ default: fsMock }));

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader (used by the factory, not needed in unit tests)
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  DATA_DIR: '/tmp/nanoclaw-telegram-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-telegram-test-groups',
  TRIGGER_PATTERN: /^@Andy\b/i,
  TELEGRAM_API_TIMEOUT_MS: 30000,
  TELEGRAM_HANDLER_TIMEOUT_MS: 90000,
  TELEGRAM_MEDIA_TIMEOUT_MS: 15000,
  TRANSCRIPTION_TIMEOUT_MS: 45000,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock transcription: the transcript is controllable per-test; the detailed
// result mirrors the production shape so diagnostics persistence is exercised.
const transcribeAudioMock = vi.hoisted(() => vi.fn());
vi.mock('../transcription.js', () => ({
  transcribeAudioDetailed: async (...args: unknown[]) => {
    const transcript = await transcribeAudioMock(...args);
    return {
      transcript,
      diagnostic: {
        audioSha256: 'test-sha256',
        audioBytes: 8,
        filename: 'voice.ogg',
        context: 'telegram_test',
        classification: transcript
          ? 'plain_transcription_succeeded'
          : 'transcription_backend_no_response_after_upload',
        attempts: [],
      },
    };
  },
  formatTranscript: (transcript: string | null, caption?: string) => {
    const suffix = caption ? ` ${caption}` : '';
    if (!transcript)
      return `[Voice message — transcription unavailable]${suffix}`;
    return `[Voice: ${transcript}]${suffix}`;
  },
}));

// --- Grammy mock ---

type Handler = (...args: any[]) => any;

const botRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('grammy', () => ({
  Bot: class MockBot {
    token: string;
    commandHandlers = new Map<string, Handler>();
    filterHandlers = new Map<string, Handler[]>();
    middlewares: Handler[] = [];
    errorHandler: Handler | null = null;

    api = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: 'voice/file_42.ogg' }),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
      config: { use: vi.fn() },
    };

    constructor(token: string) {
      this.token = token;
      botRef.current = this;
    }

    use(handler: Handler) {
      this.middlewares.push(handler);
    }

    command(name: string, handler: Handler) {
      this.commandHandlers.set(name, handler);
    }

    on(filter: string, handler: Handler) {
      const existing = this.filterHandlers.get(filter) || [];
      existing.push(handler);
      this.filterHandlers.set(filter, existing);
    }

    catch(handler: Handler) {
      this.errorHandler = handler;
    }

    start(opts: { onStart: (botInfo: any) => void }) {
      opts.onStart({ username: 'andy_ai_bot', id: 12345 });
    }

    stop() {}
  },
}));

import { TelegramChannel, TelegramChannelOpts } from './telegram.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<TelegramChannelOpts>,
): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'tg:100200300': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createTextCtx(overrides: {
  chatId?: number;
  chatType?: string;
  chatTitle?: string;
  text: string;
  fromId?: number;
  firstName?: string;
  username?: string;
  messageId?: number;
  date?: number;
  entities?: any[];
}) {
  const chatId = overrides.chatId ?? 100200300;
  const chatType = overrides.chatType ?? 'group';
  return {
    chat: {
      id: chatId,
      type: chatType,
      title: overrides.chatTitle ?? 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: overrides.username ?? 'alice_user',
    },
    message: {
      text: overrides.text,
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      entities: overrides.entities ?? [],
    },
    me: { username: 'andy_ai_bot' },
    reply: vi.fn(),
  };
}

function createMediaCtx(overrides: {
  chatId?: number;
  chatType?: string;
  fromId?: number;
  firstName?: string;
  date?: number;
  messageId?: number;
  caption?: string;
  extra?: Record<string, any>;
}) {
  const chatId = overrides.chatId ?? 100200300;
  return {
    chat: {
      id: chatId,
      type: overrides.chatType ?? 'group',
      title: 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: 'alice_user',
    },
    message: {
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      caption: overrides.caption,
      ...(overrides.extra || {}),
    },
    me: { username: 'andy_ai_bot' },
  };
}

function currentBot() {
  return botRef.current;
}

async function triggerTextMessage(ctx: ReturnType<typeof createTextCtx>) {
  const handlers = currentBot().filterHandlers.get('message:text') || [];
  for (const h of handlers) await h(ctx);
}

async function triggerMediaMessage(
  filter: string,
  ctx: ReturnType<typeof createMediaCtx>,
) {
  const handlers = currentBot().filterHandlers.get(filter) || [];
  for (const h of handlers) await h(ctx);
}

// --- Tests ---

describe('TelegramChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transcribeAudioMock.mockResolvedValue(null);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: vi
          .fn()
          .mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when bot starts', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers command and message handlers on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().commandHandlers.has('chatid')).toBe(true);
      expect(currentBot().commandHandlers.has('ping')).toBe(true);
      expect(currentBot().filterHandlers.has('message:text')).toBe(true);
      expect(currentBot().filterHandlers.has('message:photo')).toBe(true);
      expect(currentBot().filterHandlers.has('message:video')).toBe(true);
      expect(currentBot().filterHandlers.has('message:voice')).toBe(true);
      expect(currentBot().filterHandlers.has('message:audio')).toBe(true);
      expect(currentBot().filterHandlers.has('message:document')).toBe(true);
      expect(currentBot().filterHandlers.has('message:sticker')).toBe(true);
      expect(currentBot().filterHandlers.has('message:location')).toBe(true);
      expect(currentBot().filterHandlers.has('message:contact')).toBe(true);
    });

    it('installs the outbound api-timeout transformer on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      // Guards the IPC watcher / container output chain from a stalled send.
      expect(currentBot().api.config.use).toHaveBeenCalledOnce();
    });

    it('installs an inbound handler-timeout middleware on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      // Guards grammy's sequential poll loop from a hung handler.
      expect(currentBot().middlewares.length).toBeGreaterThanOrEqual(1);
    });

    it('registers error handler on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().errorHandler).not.toBeNull();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hello everyone' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          id: '1',
          chat_jid: 'tg:100200300',
          sender: '99001',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ chatId: 999999, text: 'Unknown chat' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:999999',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips command messages (starting with /)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: '/start' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('extracts sender name from first_name', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', firstName: 'Bob' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'Bob' }),
      );
    });

    it('falls back to username when first_name missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi' });
      ctx.from.first_name = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'alice_user' }),
      );
    });

    it('falls back to user ID when name and username missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', fromId: 42 });
      ctx.from.first_name = undefined as any;
      ctx.from.username = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: '42' }),
      );
    });

    it('uses sender name as chat name for private chats', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'Private',
            folder: 'private',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'private',
        firstName: 'Alice',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Alice', // Private chats use sender name
        'telegram',
        false,
      );
    });

    it('uses chat title as name for group chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'supergroup',
        chatTitle: 'Project Team',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Project Team',
        'telegram',
        true,
      );
    });

    it('converts message.date to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const unixTime = 1704067200; // 2024-01-01T00:00:00.000Z
      const ctx = createTextCtx({ text: 'Hello', date: unixTime });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });
  });

  // --- quoted voice re-fetch (reply to a voice note) ---

  describe('quoted voice re-fetch', () => {
    function createReplyToVoiceCtx(voiceFileId: string, replyText: string) {
      return {
        chat: { id: 100200300, type: 'group', title: 'Test Group' },
        from: { id: 99001, first_name: 'Alice', username: 'alice_user' },
        message: {
          text: replyText,
          date: Math.floor(Date.now() / 1000),
          message_id: 2,
          entities: [],
          reply_to_message: {
            voice: { file_id: voiceFileId },
            from: { is_bot: false },
          },
        },
        me: { username: 'andy_ai_bot' },
        reply: vi.fn(),
      };
    }

    it('transcribes the quoted voice note instead of asking to resend', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(8),
        }),
      );
      transcribeAudioMock.mockResolvedValueOnce(
        'the words in the missed voice note',
      );

      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createReplyToVoiceCtx('VOICE_42', 'you never processed this');
      await triggerTextMessage(ctx as any);

      // It fetched the quoted voice by its file_id rather than dropping it.
      expect(currentBot().api.getFile).toHaveBeenCalledWith('VOICE_42');
      // The transcript is surfaced to the agent in the reply context.
      const delivered = (opts.onMessage as any).mock.calls[0][1];
      expect(delivered.content).toContain('the words in the missed voice note');
      expect(delivered.content).toContain('you never processed this');

      vi.unstubAllGlobals();
    });

    it('falls back to a placeholder when the quoted voice cannot be transcribed', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(8),
        }),
      );
      transcribeAudioMock.mockResolvedValueOnce(null);

      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createReplyToVoiceCtx('VOICE_99', 'this one');
      await triggerTextMessage(ctx as any);

      const delivered = (opts.onMessage as any).mock.calls[0][1];
      expect(delivered.content).toContain('/workspace/ipc/media/voice_reply_');
      expect(delivered.content).toContain('this one');

      vi.unstubAllGlobals();
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates @bot_username mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@andy_ai_bot what time is it?',
        entities: [{ type: 'mention', offset: 0, length: 12 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy @andy_ai_bot what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@Andy @andy_ai_bot hello',
        entities: [{ type: 'mention', offset: 6, length: 12 }],
      });
      await triggerTextMessage(ctx);

      // Should NOT double-prepend — already starts with @Andy
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy @andy_ai_bot hello',
        }),
      );
    });

    it('does not translate mentions of other bots', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@some_other_bot hi',
        entities: [{ type: 'mention', offset: 0, length: 15 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@some_other_bot hi', // No translation
        }),
      );
    });

    it('handles mention in middle of message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'hey @andy_ai_bot check this',
        entities: [{ type: 'mention', offset: 4, length: 12 }],
      });
      await triggerTextMessage(ctx);

      // Bot is mentioned, message doesn't match trigger → prepend trigger
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy hey @andy_ai_bot check this',
        }),
      );
    });

    it('handles message with no entities', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'plain message' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'plain message',
        }),
      );
    });

    it('ignores non-mention entities', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'check https://example.com',
        entities: [{ type: 'url', offset: 6, length: 19 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'check https://example.com',
        }),
      );
    });
  });

  // --- Non-text messages ---

  describe('non-text messages', () => {
    it('stores photo with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo]' }),
      );
    });

    it('stores photo with caption', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ caption: 'Look at this' });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo] Look at this' }),
      );
    });

    it('stores video with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:video', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Video]' }),
      );
    });

    it('retains voice audio and file metadata when transcription fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        messageId: 77,
        extra: {
          voice: {
            file_id: 'telegram-file-77',
            file_unique_id: 'unique-77',
            duration: 42,
            mime_type: 'audio/ogg',
          },
        },
      });
      await triggerMediaMessage('message:voice', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: expect.stringContaining('/workspace/ipc/media/voice_77.ogg'),
        }),
      );
      expect(fsMock.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('voice_77.ogg'),
        expect.any(Buffer),
      );
      expect(fsMock.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('voice_77.json'),
        expect.stringContaining(
          '"classification": "transcription_backend_no_response_after_upload"',
        ),
      );
    });

    it('removes retained audio after successful transcription', async () => {
      transcribeAudioMock.mockResolvedValueOnce('hello from the voice note');
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        messageId: 78,
        extra: {
          voice: {
            file_id: 'telegram-file-78',
            file_unique_id: 'unique-78',
            duration: 3,
            mime_type: 'audio/ogg',
          },
        },
      });
      await triggerMediaMessage('message:voice', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Voice: hello from the voice note]',
        }),
      );
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('voice_78.ogg'),
      );
      expect(fsMock.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('voice_78.json'),
        expect.stringContaining('"status": "transcribed"'),
      );
    });

    it('stores audio with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:audio', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Audio]' }),
      );
    });

    it('stores document with filename', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { document: { file_name: 'report.pdf' } },
      });
      await triggerMediaMessage('message:document', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Document: report.pdf]' }),
      );
    });

    it('stores document with fallback name when filename missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ extra: { document: {} } });
      await triggerMediaMessage('message:document', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Document: file]' }),
      );
    });

    it('stores sticker with emoji', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { sticker: { emoji: '😂' } },
      });
      await triggerMediaMessage('message:sticker', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Sticker 😂]' }),
      );
    });

    it('stores location with coordinates', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { location: { latitude: 38.7169, longitude: -9.1333 } },
      });
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Location: 38.7169,-9.1333]',
        }),
      );
    });

    it('stores location without coordinates as fallback', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Location]' }),
      );
    });

    it('stores contact with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:contact', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Contact]' }),
      );
    });

    it('ignores non-text messages from unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ chatId: 999999 });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via bot API', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Hello');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Hello',
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
    });

    it('strips tg: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:-1001234567890', 'Group message');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '-1001234567890',
        'Group message',
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
    });

    it('splits messages exceeding 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('tg:100200300', longText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        1,
        '100200300',
        'x'.repeat(4096),
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '100200300',
        'x'.repeat(904),
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
    });

    it('sends exactly one message at 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const exactText = 'y'.repeat(4096);
      await channel.sendMessage('tg:100200300', exactText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendMessage.mockRejectedValueOnce(
        new Error('Network error'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('tg:100200300', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      // Don't connect — bot is null
      await channel.sendMessage('tg:100200300', 'No bot');

      // No error, no API call
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns tg: JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(true);
    });

    it('owns tg: JIDs with negative IDs (groups)', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:-1001234567890')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing action when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', true);

      expect(currentBot().api.sendChatAction).toHaveBeenCalledWith(
        '100200300',
        'typing',
      );
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', false);

      expect(currentBot().api.sendChatAction).not.toHaveBeenCalled();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      // Don't connect
      await channel.setTyping('tg:100200300', true);

      // No error, no API call
    });

    it('handles typing indicator failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendChatAction.mockRejectedValueOnce(
        new Error('Rate limited'),
      );

      await expect(
        channel.setTyping('tg:100200300', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Bot commands ---

  describe('bot commands', () => {
    it('/chatid replies with chat ID and metadata', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 100200300, type: 'group' as const },
        from: { first_name: 'Alice' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('tg:100200300'),
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
    });

    it('/chatid shows chat type', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 555, type: 'private' as const },
        from: { first_name: 'Bob' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('private'),
        expect.any(Object),
      );
    });

    it('/ping replies with bot status', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('ping')!;
      const ctx = { reply: vi.fn() };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Andy is online.');
    });

    it.each(['approve', 'reject'])(
      '/%s routes directly to the host command boundary',
      async (command) => {
        const onHostCommand = vi.fn().mockResolvedValue({
          reply: `${command} accepted`,
        });
        const opts = createTestOpts({ onHostCommand });
        const channel = new TelegramChannel('test-token', opts);
        await channel.connect();

        const handler = currentBot().commandHandlers.get(command)!;
        const ctx = {
          ...createTextCtx({
            chatId: 555,
            chatType: 'private',
            text: `/${command} G-0123456789`,
            fromId: 42,
          }),
          match: 'G-0123456789',
        };
        await handler(ctx);

        expect(onHostCommand).toHaveBeenCalledWith(
          command,
          'G-0123456789',
          'tg:555',
          expect.objectContaining({
            sender: '42',
            content: `/${command} G-0123456789`,
          }),
        );
        expect(ctx.reply).toHaveBeenCalledWith(`${command} accepted`);
        expect(opts.onMessage).not.toHaveBeenCalled();
      },
    );

    it('sends Google approvals with native inline controls', async () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      await channel.connect();

      await channel.sendApprovalMessageStrict(
        'tg:555',
        'Approval required',
        'G-0123456789',
      );

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '555',
        'Approval required',
        expect.objectContaining({
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '✅ Approve',
                  callback_data: 'google-approval:approve:G-0123456789',
                },
                {
                  text: '❌ Reject',
                  callback_data: 'google-approval:reject:G-0123456789',
                },
              ],
            ],
          },
        }),
      );
    });

    it.each(['approve', 'reject'])(
      'routes an inline %s decision through the same host boundary',
      async (command) => {
        const onHostCommand = vi.fn().mockResolvedValue({
          reply: `${command} accepted`,
        });
        const opts = createTestOpts({ onHostCommand });
        const channel = new TelegramChannel('test-token', opts);
        await channel.connect();

        const handler = currentBot().filterHandlers.get(
          'callback_query:data',
        )![0];
        const ctx = {
          callbackQuery: {
            id: 'callback-1',
            data: `google-approval:${command}:G-0123456789`,
            message: {
              message_id: 77,
              chat: { id: 555, type: 'private' },
              text: 'Approval required',
            },
          },
          from: {
            id: 42,
            first_name: 'Alice',
            username: 'alice_user',
          },
          api: currentBot().api,
          reply: vi.fn().mockResolvedValue(undefined),
        };

        await handler(ctx);

        expect(onHostCommand).toHaveBeenCalledWith(
          command,
          'G-0123456789',
          'tg:555',
          expect.objectContaining({
            id: 'callback-callback-1',
            sender: '42',
            content: `/${command} G-0123456789`,
          }),
        );
        expect(currentBot().api.answerCallbackQuery).toHaveBeenCalledWith(
          'callback-1',
          { text: `${command} accepted` },
        );
        expect(currentBot().api.editMessageReplyMarkup).toHaveBeenCalledWith(
          555,
          77,
          { reply_markup: { inline_keyboard: [] } },
        );
        expect(ctx.reply).toHaveBeenCalledWith(`${command} accepted`);
        expect(opts.onMessage).not.toHaveBeenCalled();
      },
    );

    it('leaves approval controls intact when callback authorization fails', async () => {
      const onHostCommand = vi
        .fn()
        .mockRejectedValue(new Error('You are not authorized.'));
      const channel = new TelegramChannel(
        'test-token',
        createTestOpts({ onHostCommand }),
      );
      await channel.connect();

      const handler = currentBot().filterHandlers.get(
        'callback_query:data',
      )![0];
      const ctx = {
        callbackQuery: {
          id: 'callback-denied',
          data: 'google-approval:approve:G-0123456789',
          message: {
            message_id: 77,
            chat: { id: 555, type: 'private' },
          },
        },
        from: { id: 999, first_name: 'Mallory' },
        api: currentBot().api,
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(currentBot().api.answerCallbackQuery).toHaveBeenCalledWith(
        'callback-denied',
        { text: 'You are not authorized.', show_alert: true },
      );
      expect(currentBot().api.editMessageReplyMarkup).not.toHaveBeenCalled();
      expect(ctx.reply).not.toHaveBeenCalled();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "telegram"', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.name).toBe('telegram');
    });
  });
});
