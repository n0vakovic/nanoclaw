import fs from 'fs';
import path from 'path';

import { Api, Bot, InputFile } from 'grammy';
import type { Transformer } from 'grammy';

import {
  ASSISTANT_NAME,
  TRIGGER_PATTERN,
  TELEGRAM_API_TIMEOUT_MS,
  TELEGRAM_HANDLER_TIMEOUT_MS,
  TELEGRAM_MEDIA_TIMEOUT_MS,
} from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupIpcPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { transcribeAudio, formatTranscript } from '../transcription.js';
import { fetchWithTimeout } from '../timeout.js';
import {
  createHandlerTimeoutMiddleware,
  createApiTimeoutTransformer,
} from '../bot-guards.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface RetainedTelegramVoice {
  buffer: Buffer | null;
  filename: string | null;
  hostAudioPath: string | null;
  containerAudioPath: string | null;
  hostMetadataPath: string;
  containerMetadataPath: string;
  metadata: Record<string, unknown>;
  error?: unknown;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

/**
 * Build a <reply_to> wrapper around `body` when the inbound Telegram message
 * is a reply to a previous one. Returns `body` unchanged if no reply context.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapReplyContext(
  replyTo: any,
  body: string,
  // When we've transcribed a quoted voice note, pass the transcript as
  // quotedOverride with a larger maxLen so the agent sees the actual content
  // the user is pointing back at — not a truncated 200-char snippet.
  opts: { quotedOverride?: string; maxLen?: number } = {},
): string {
  if (!replyTo) return body;

  const maxLen = opts.maxLen ?? 200;
  let quoted: string;
  if (opts.quotedOverride) {
    quoted = opts.quotedOverride;
  } else if (typeof replyTo.text === 'string' && replyTo.text.length > 0) {
    quoted = replyTo.text;
  } else if (
    typeof replyTo.caption === 'string' &&
    replyTo.caption.length > 0
  ) {
    quoted = replyTo.caption;
  } else if (replyTo.voice) {
    quoted = '[voice]';
  } else if (replyTo.photo) {
    quoted = '[photo]';
  } else if (replyTo.audio) {
    quoted = '[audio]';
  } else if (replyTo.video) {
    quoted = '[video]';
  } else if (replyTo.document) {
    quoted = '[document]';
  } else if (replyTo.sticker) {
    quoted = '[sticker]';
  } else {
    quoted = '[message]';
  }

  if (quoted.length > maxLen) {
    quoted = quoted.slice(0, maxLen) + '…';
  }
  // Escape for safe embedding in the XML-style wrapper attribute
  const escaped = quoted
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');

  const senderRole = replyTo.from?.is_bot ? 'bot' : 'user';

  return `<reply_to sender="${senderRole}" text="${escaped}">\n${body}\n</reply_to>`;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private reactionMsgIds = new Map<string, number>();

  private async setReaction(jid: string, emoji: string): Promise<void> {
    if (!this.bot) return;
    const msgId = this.reactionMsgIds.get(jid);
    if (!msgId) return;
    try {
      const chatId = jid.replace(/^tg:/, '');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.bot.api.setMessageReaction(Number(chatId), msgId, [
        { type: 'emoji', emoji: emoji as any },
      ]);
    } catch {
      // silently ignore — reactions may not be available in all chat types
    }
  }

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /**
   * Persist Telegram recovery metadata before attempting a download, then keep
   * the downloaded voice file until transcription succeeds. A Telegram message
   * ID alone cannot be used with getFile(); the file_id must survive failures.
   */
  private async retainTelegramVoice(opts: {
    chatJid: string;
    groupFolder: string;
    messageId: string | number;
    fileId: string;
    fileUniqueId?: string;
    duration?: number;
    mimeType?: string;
    source: 'message' | 'reply';
  }): Promise<RetainedTelegramVoice> {
    const safeMessageId = String(opts.messageId).replace(
      /[^A-Za-z0-9_-]/g,
      '_',
    );
    const basename = `voice_${safeMessageId}`;
    const mediaDir = path.join(resolveGroupIpcPath(opts.groupFolder), 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    const metadataFilename = `${basename}.json`;
    const hostMetadataPath = path.join(mediaDir, metadataFilename);
    const containerMetadataPath = `/workspace/ipc/media/${metadataFilename}`;
    const metadata: Record<string, unknown> = {
      source: 'telegram',
      recovery_source: opts.source,
      status: 'download_pending',
      chat_jid: opts.chatJid,
      telegram_message_id: String(opts.messageId),
      telegram_file_id: opts.fileId,
      telegram_file_unique_id: opts.fileUniqueId || null,
      duration_seconds: opts.duration ?? null,
      mime_type: opts.mimeType || 'audio/ogg',
      received_at: new Date().toISOString(),
    };
    const writeMetadata = () =>
      fs.writeFileSync(
        hostMetadataPath,
        JSON.stringify(metadata, null, 2) + '\n',
      );
    writeMetadata();

    try {
      if (!this.bot) throw new Error('Telegram bot not initialized');
      if (!opts.fileId) throw new Error('Telegram voice has no file_id');

      const file = await this.bot.api.getFile(opts.fileId);
      if (!file.file_path) {
        throw new Error('Telegram getFile returned no file_path');
      }
      const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const resp = await fetchWithTimeout(url, TELEGRAM_MEDIA_TIMEOUT_MS);
      if (!resp.ok) {
        throw new Error(`Telegram voice download returned HTTP ${resp.status}`);
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      const ext = path.extname(file.file_path).toLowerCase() || '.ogg';
      const filename = `${basename}${ext}`;
      const hostAudioPath = path.join(mediaDir, filename);
      const containerAudioPath = `/workspace/ipc/media/${filename}`;
      fs.writeFileSync(hostAudioPath, buffer);

      Object.assign(metadata, {
        status: 'downloaded',
        telegram_file_path: file.file_path,
        filename,
        audio_path: containerAudioPath,
        bytes: buffer.length,
        downloaded_at: new Date().toISOString(),
      });
      writeMetadata();

      return {
        buffer,
        filename,
        hostAudioPath,
        containerAudioPath,
        hostMetadataPath,
        containerMetadataPath,
        metadata,
      };
    } catch (error) {
      Object.assign(metadata, {
        status: 'download_failed',
        failed_at: new Date().toISOString(),
      });
      writeMetadata();
      return {
        buffer: null,
        filename: null,
        hostAudioPath: null,
        containerAudioPath: null,
        hostMetadataPath,
        containerMetadataPath,
        metadata,
        error,
      };
    }
  }

  private updateRetainedVoice(
    retained: RetainedTelegramVoice,
    patch: Record<string, unknown>,
  ): void {
    Object.assign(retained.metadata, patch);
    fs.writeFileSync(
      retained.hostMetadataPath,
      JSON.stringify(retained.metadata, null, 2) + '\n',
    );
  }

  private markRetainedVoiceTranscribed(
    retained: RetainedTelegramVoice,
    transcriptLength: number,
  ): void {
    if (retained.hostAudioPath) {
      try {
        fs.unlinkSync(retained.hostAudioPath);
      } catch (err) {
        logger.warn(
          { err, audioPath: retained.hostAudioPath },
          'Failed to remove transcribed Telegram voice file',
        );
      }
    }
    this.updateRetainedVoice(retained, {
      status: 'transcribed',
      audio_path: null,
      transcript_chars: transcriptLength,
      transcribed_at: new Date().toISOString(),
    });
  }

  /**
   * Download and transcribe a quoted voice/audio message by its file_id.
   * Everything needed is already on Telegram, so replying to a voice note the
   * bot missed should recover its content — never ask the user to resend.
   * Retains the file and file_id metadata if transcription fails.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async transcribeQuotedAudio(
    replyTo: any,
    chatJid: string,
    groupFolder?: string,
  ): Promise<{
    transcript: string | null;
    audioPath?: string;
    metadataPath?: string;
  }> {
    const media = replyTo?.voice || replyTo?.audio;
    const fileId = media?.file_id;
    if (!fileId || !groupFolder) return { transcript: null };

    const retained = await this.retainTelegramVoice({
      chatJid,
      groupFolder,
      messageId: replyTo.message_id || `reply_${Date.now()}`,
      fileId,
      fileUniqueId: media.file_unique_id,
      duration: media.duration,
      mimeType: media.mime_type,
      source: 'reply',
    });
    if (!retained.buffer || !retained.filename) {
      logger.error(
        { err: retained.error, chatJid },
        'Failed to download quoted Telegram voice message',
      );
      return {
        transcript: null,
        metadataPath: retained.containerMetadataPath,
      };
    }

    const transcript = await transcribeAudio(
      retained.buffer,
      retained.filename,
    );
    if (transcript) {
      this.markRetainedVoiceTranscribed(retained, transcript.length);
      return { transcript };
    }

    this.updateRetainedVoice(retained, {
      status: 'transcription_failed',
      failed_at: new Date().toISOString(),
    });
    return {
      transcript: null,
      audioPath: retained.containerAudioPath || undefined,
      metadataPath: retained.containerMetadataPath,
    };
  }

  /**
   * Build the <reply_to> context for an inbound message. If it quotes a voice
   * or audio message (and has no text/caption of its own), transcribe that
   * quoted audio and surface the transcript instead of a bare [voice] marker.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async enrichReplyContext(
    replyTo: any,
    body: string,
    chatJid: string,
    groupFolder?: string,
  ): Promise<string> {
    const quotesAudio = replyTo && (replyTo.voice || replyTo.audio);
    const hasOwnText =
      (typeof replyTo?.text === 'string' && replyTo.text.length > 0) ||
      (typeof replyTo?.caption === 'string' && replyTo.caption.length > 0);
    if (quotesAudio && !hasOwnText) {
      const recovered = await this.transcribeQuotedAudio(
        replyTo,
        chatJid,
        groupFolder,
      );
      if (recovered.transcript) {
        return wrapReplyContext(replyTo, body, {
          quotedOverride: `[voice: ${recovered.transcript}]`,
          maxLen: 4000,
        });
      }
      const recoveryLocation = recovered.audioPath
        ? `audio retained at ${recovered.audioPath}`
        : recovered.metadataPath
          ? `Telegram file metadata retained at ${recovered.metadataPath}`
          : null;
      if (recoveryLocation) {
        return wrapReplyContext(replyTo, body, {
          quotedOverride: `[voice message — transcription unavailable; ${recoveryLocation}]`,
          maxLen: 4000,
        });
      }
    }
    return wrapReplyContext(replyTo, body);
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Outbound backstop: every bot.api.* call gets a hard timeout so a stalled
    // Telegram send can never freeze the IPC watcher or container output chain.
    this.bot.api.config.use(
      createApiTimeoutTransformer(
        TELEGRAM_API_TIMEOUT_MS,
      ) as unknown as Transformer,
    );

    // Inbound backstop: grammy processes updates sequentially, so one hung
    // handler would freeze the whole poll loop. Registered FIRST so it wraps
    // every command/message handler below — no update can block longer than
    // its budget. See docs/concurrency-model.md.
    this.bot.use(createHandlerTimeoutMiddleware(TELEGRAM_HANDLER_TIMEOUT_MS));

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;
      const group = this.opts.registeredGroups()[chatJid];

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // If this is a reply to another message, surface that context to the
      // agent — transcribing a quoted voice note if there is one.
      content = await this.enrichReplyContext(
        (ctx.message as any).reply_to_message,
        content,
        chatJid,
        group?.folder,
      );

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Acknowledge with 👀 and track message ID for status reactions
      this.reactionMsgIds.set(chatJid, ctx.message.message_id);
      void this.setReaction(chatJid, '👀');

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      this.reactionMsgIds.set(chatJid, ctx.message.message_id);
      void this.setReaction(chatJid, '👀');

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      const content = wrapReplyContext(
        ctx.message.reply_to_message,
        `${placeholder}${caption}`,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.reactionMsgIds.set(chatJid, ctx.message.message_id);
      void this.setReaction(chatJid, '👀');

      let content: string;
      try {
        // Grab the largest available size (last element)
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1];
        const file = await ctx.api.getFile(largest.file_id);
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const resp = await fetchWithTimeout(url, TELEGRAM_MEDIA_TIMEOUT_MS);
        const buffer = Buffer.from(await resp.arrayBuffer());

        const ext = path.extname(file.file_path || '').toLowerCase() || '.jpg';
        const filename = `photo_${ctx.message.message_id}${ext}`;
        const mediaDir = path.join(resolveGroupIpcPath(group.folder), 'media');
        fs.mkdirSync(mediaDir, { recursive: true });
        fs.writeFileSync(path.join(mediaDir, filename), buffer);

        const containerPath = `/workspace/ipc/media/${filename}`;
        content = `[Photo: ${containerPath}]${caption}\n\nThe image is at ${containerPath} — use Read to view it, then delete it with Bash when done.`;
        logger.info(
          { chatJid, filename, bytes: buffer.length },
          'Saved Telegram photo to IPC media',
        );
      } catch (err) {
        logger.error({ err }, 'Failed to download Telegram photo');
        content = `[Photo]${caption}`;
      }

      content = wrapReplyContext(
        (ctx.message as any).reply_to_message,
        content,
      );

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption;
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      this.reactionMsgIds.set(chatJid, ctx.message.message_id);
      void this.setReaction(chatJid, '👀');

      let content: string;
      const voice = ctx.message.voice;
      const retained = await this.retainTelegramVoice({
        chatJid,
        groupFolder: group.folder,
        messageId: ctx.message.message_id,
        fileId: voice?.file_id || '',
        fileUniqueId: voice?.file_unique_id,
        duration: voice?.duration,
        mimeType: voice?.mime_type,
        source: 'message',
      });
      if (retained.buffer && retained.filename) {
        const transcript = await transcribeAudio(
          retained.buffer,
          retained.filename,
        );
        content = formatTranscript(transcript, caption);
        if (transcript) {
          this.markRetainedVoiceTranscribed(retained, transcript.length);
          logger.info(
            {
              chatJid,
              messageId: ctx.message.message_id,
              chars: transcript.length,
            },
            'Transcribed Telegram voice message',
          );
        } else {
          this.updateRetainedVoice(retained, {
            status: 'transcription_failed',
            failed_at: new Date().toISOString(),
          });
          content += `\n\nAudio retained at ${retained.containerAudioPath}. Recovery metadata: ${retained.containerMetadataPath}.`;
          logger.warn(
            {
              chatJid,
              messageId: ctx.message.message_id,
              audioPath: retained.containerAudioPath,
            },
            'Telegram voice transcription unavailable; retained audio',
          );
        }
      } else {
        logger.error(
          {
            err: retained.error,
            chatJid,
            messageId: ctx.message.message_id,
            metadataPath: retained.containerMetadataPath,
          },
          'Failed to download Telegram voice message',
        );
        content = formatTranscript(null, caption);
        content += `\n\nTelegram file metadata retained at ${retained.containerMetadataPath} for retry.`;
      }

      content = wrapReplyContext(
        (ctx.message as any).reply_to_message,
        content,
      );

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => {
      const loc = ctx.message.location;
      const tag = loc
        ? `[Location: ${loc.latitude},${loc.longitude}]`
        : '[Location]';
      storeNonText(ctx, tag);
    });
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Forward user emoji reactions to the agent as messages
    this.bot.on('message_reaction', async (ctx) => {
      const reaction = ctx.messageReaction;
      const chatJid = `tg:${reaction.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      // Only forward newly added reactions (ignore removals)
      const oldEmojis = new Set(
        (reaction.old_reaction ?? [])
          .filter((r) => r.type === 'emoji')
          .map((r) => (r as { type: 'emoji'; emoji: string }).emoji),
      );
      const added = (reaction.new_reaction ?? [])
        .filter((r) => r.type === 'emoji')
        .map((r) => (r as { type: 'emoji'; emoji: string }).emoji)
        .filter((e) => !oldEmojis.has(e));
      if (added.length === 0) return;

      const user = reaction.user;
      const senderName = user
        ? user.first_name || user.username || String(user.id)
        : 'User';
      const timestamp = new Date(reaction.date * 1000).toISOString();

      this.opts.onMessage(chatJid, {
        id: `reaction-${reaction.message_id}-${Date.now()}`,
        chat_jid: chatJid,
        sender: user?.id.toString() ?? '',
        sender_name: senderName,
        content: `@${ASSISTANT_NAME} [User reacted with: ${added.join('')}]`,
        timestamp,
        is_from_me: false,
      });
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendVoice(jid: string, audioPath: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendVoice(numericId, new InputFile(audioPath));
      logger.info({ jid, audioPath }, 'Telegram voice note sent');
    } catch (err) {
      logger.error({ jid, audioPath, err }, 'Failed to send Telegram voice');
    }
  }

  async sendAudio(
    jid: string,
    audioPath: string,
    meta?: { title?: string; performer?: string; caption?: string },
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendAudio(numericId, new InputFile(audioPath), {
        title: meta?.title,
        performer: meta?.performer,
        caption: meta?.caption,
      });
      logger.info({ jid, audioPath, meta }, 'Telegram audio sent');
    } catch (err) {
      logger.error({ jid, audioPath, err }, 'Failed to send Telegram audio');
    }
  }

  async sendDocument(
    jid: string,
    filePath: string,
    meta?: { caption?: string },
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendDocument(numericId, new InputFile(filePath), {
        caption: meta?.caption,
      });
      logger.info({ jid, filePath, meta }, 'Telegram document sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Telegram document');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot) return;
    if (isTyping) {
      try {
        const numericId = jid.replace(/^tg:/, '');
        await this.bot.api.sendChatAction(numericId, 'typing');
      } catch (err) {
        logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
      }
    }
    void this.setReaction(jid, isTyping ? '🤔' : '👍');
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
