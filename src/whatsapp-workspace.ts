import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import {
  WHATSAPP_MEDIA_TIMEOUT_MS,
  WHATSAPP_MAX_RESULT_BYTES,
  WHATSAPP_QUERY_TIMEOUT_MS,
  WHATSAPP_STORE_DIR,
  WHATSAPP_SYNC_SERVICE,
  WHATSAPP_WACLI_PATH,
} from './config.js';

const execFileAsync = promisify(execFile);
type ExecRunner = (
  file: string,
  args: string[],
  options: Record<string, unknown>,
) => Promise<{ stdout: string; stderr?: string }>;
const productionExec = execFileAsync as unknown as ExecRunner;
let execute: ExecRunner = productionExec;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`whatsapp: invalid ${label} response`);
  }
  return value as JsonRecord;
}

function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max) {
    throw new Error(`whatsapp: expected integer from 1 to ${max}`);
  }
  return Number(value);
}

function optionalDate(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw new Error(`whatsapp: invalid ${label}`);
  }
  return value;
}

function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`whatsapp: invalid ${label}`);
  }
  return value.trim();
}

async function runWacli(
  command: string[],
  timeout = WHATSAPP_QUERY_TIMEOUT_MS,
): Promise<unknown> {
  if (!path.isAbsolute(WHATSAPP_WACLI_PATH)) {
    throw new Error('whatsapp: WHATSAPP_WACLI_PATH must be absolute');
  }
  if (!path.isAbsolute(WHATSAPP_STORE_DIR)) {
    throw new Error('whatsapp: WHATSAPP_STORE_DIR must be absolute');
  }
  const { stdout } = await execute(
    WHATSAPP_WACLI_PATH,
    ['--store', WHATSAPP_STORE_DIR, '--read-only', '--json', ...command],
    {
      timeout,
      maxBuffer: WHATSAPP_MAX_RESULT_BYTES,
      encoding: 'utf8',
    },
  );
  const envelope = record(JSON.parse(stdout), 'JSON');
  if (envelope.success !== true) {
    const error = record(envelope.error || {}, 'error');
    throw new Error(`whatsapp: ${String(error.message || 'wacli failed')}`);
  }
  return envelope.data;
}

function chatView(chat: JsonRecord) {
  const last = String(chat.last_message_ts || '');
  return {
    chatId: String(chat.jid || ''),
    name: String(chat.name || ''),
    kind: String(chat.kind || 'unknown'),
    lastMessageAt: last && !last.startsWith('0001-') ? last : null,
    archived: chat.archived === true,
    pinned: chat.pinned === true,
    unread: chat.unread === true,
    unreadCount: Number(chat.unread_count || 0),
    coverage: last && !last.startsWith('0001-') ? 'ready' : 'metadata_only',
  };
}

function messageView(message: JsonRecord) {
  return {
    chatId: String(message.ChatJID || ''),
    messageId: String(message.MsgID || ''),
    timestamp: String(message.Timestamp || ''),
    fromMe: message.FromMe === true,
    senderId: message.SenderJID ? String(message.SenderJID) : undefined,
    senderName: message.SenderName ? String(message.SenderName) : undefined,
    text: String(message.Text || message.DisplayText || ''),
    media:
      message.MediaType || message.MimeType
        ? {
            type: String(message.MediaType || ''),
            mimeType: message.MimeType ? String(message.MimeType) : undefined,
            filename: message.Filename ? String(message.Filename) : undefined,
          }
        : undefined,
    edited: message.Edited === true,
    revoked: message.Revoked === true,
  };
}

async function listRaw(query?: string, limit = 50): Promise<JsonRecord[]> {
  const args = ['chats', 'list', '--limit', String(limit)];
  if (query) args.push('--query', query);
  const data = await runWacli(args);
  return Array.isArray(data) ? (data as JsonRecord[]) : [];
}

async function readRaw(
  chatId: string,
  limit: number,
  after?: string,
  before?: string,
): Promise<JsonRecord[]> {
  const args = ['messages', 'list', '--chat', chatId, '--limit', String(limit)];
  if (after) args.push('--after', after);
  if (before) args.push('--before', before);
  const data = record(await runWacli(args), 'messages');
  return Array.isArray(data.messages) ? (data.messages as JsonRecord[]) : [];
}

async function serviceState(): Promise<string> {
  if (!/^[A-Za-z0-9_.@-]+\.service$/.test(WHATSAPP_SYNC_SERVICE))
    return 'unknown';
  try {
    const { stdout } = await execute(
      'systemctl',
      ['--user', 'is-active', WHATSAPP_SYNC_SERVICE],
      { timeout: 5000, maxBuffer: 4096, encoding: 'utf8' },
    );
    return stdout.trim() === 'active' ? 'running' : 'stopped';
  } catch {
    return 'stopped';
  }
}

export async function whatsappStatus(): Promise<string> {
  const data = record(await runWacli(['doctor']), 'doctor');
  const store = record(data.store || {}, 'store');
  return bounded({
    authenticated: data.authenticated === true,
    serviceState: await serviceState(),
    ftsEnabled: data.fts_enabled === true,
    lockHeld: data.lock_held === true,
    lastSyncAt: store.last_sync_at || null,
    lastActivityAt: store.last_activity_at || null,
    counts: {
      messages: Number(store.messages || 0),
      chats: Number(store.chats || 0),
      contacts: Number(store.contacts || 0),
      groups: Number(store.groups || 0),
    },
  });
}

export async function whatsappListChats(params: JsonRecord): Promise<string> {
  const query =
    params.query === undefined ? undefined : text(params.query, 'query');
  const limit = integer(params.limit, 20, 50);
  const chats = (await listRaw(query, limit)).map(chatView);
  return bounded({
    chats: chats.filter((c) => params.includeArchived === true || !c.archived),
  });
}

export async function whatsappRead(params: JsonRecord): Promise<string> {
  const names = params.chatNames;
  const recent = params.recentChatCount;
  if ((names === undefined) === (recent === undefined)) {
    throw new Error(
      'whatsapp: provide exactly one of chatNames or recentChatCount',
    );
  }
  const perChat = integer(params.messagesPerChat, 30, 100);
  const after = optionalDate(params.after, 'after');
  const before = optionalDate(params.before, 'before');
  const includeArchived = params.includeArchived === true;
  const selected: Array<{
    chat: JsonRecord;
    requested?: string;
    error?: string;
    candidates?: unknown[];
  }> = [];

  if (names !== undefined) {
    if (!Array.isArray(names) || names.length < 1 || names.length > 20) {
      throw new Error('whatsapp: chatNames must contain 1 to 20 names');
    }
    for (const value of names) {
      const requested = text(value, 'chat name', 200);
      const matches = await listRaw(requested, 20);
      const normalized = requested.toLocaleLowerCase();
      const exact = matches.filter(
        (c) =>
          String(c.name || '')
            .trim()
            .toLocaleLowerCase() === normalized,
      );
      if (exact.length === 1) selected.push({ chat: exact[0], requested });
      else if (matches.length === 1)
        selected.push({ chat: matches[0], requested });
      else
        selected.push({
          chat: {},
          requested,
          error: matches.length ? 'ambiguous_chat' : 'chat_not_found',
          candidates: matches.slice(0, 10).map(chatView),
        });
    }
  } else {
    const count = integer(recent, 10, 20);
    const chats = await listRaw(undefined, 1000);
    chats.sort((a, b) =>
      String(b.last_message_ts || '').localeCompare(
        String(a.last_message_ts || ''),
      ),
    );
    for (const chat of chats) {
      const view = chatView(chat);
      if (!view.lastMessageAt || (!includeArchived && view.archived)) continue;
      selected.push({ chat });
      if (selected.length === count) break;
    }
  }

  const chats = await mapLimit(selected, 4, async (item) => {
    if (item.error)
      return {
        requested: item.requested,
        error: item.error,
        candidates: item.candidates,
      };
    const view = chatView(item.chat);
    if (view.coverage === 'metadata_only') return { ...view, messages: [] };
    try {
      const messages = (await readRaw(view.chatId, perChat, after, before))
        .map(messageView)
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      return { ...view, messages };
    } catch (error) {
      return {
        ...view,
        messages: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  return bounded({
    fetchedAt: new Date().toISOString(),
    serviceState: await serviceState(),
    chats,
  });
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await mapper(values[index]);
      }
    }),
  );
  return results;
}

export async function whatsappSearch(params: JsonRecord): Promise<string> {
  const query = text(params.query, 'query');
  const limit = integer(params.limit, 20, 50);
  const args = ['messages', 'search', query, '--limit', String(limit)];
  for (const [key, flag] of [
    ['chatId', '--chat'],
    ['after', '--after'],
    ['before', '--before'],
  ] as const) {
    if (params[key] !== undefined) args.push(flag, text(params[key], key, 256));
  }
  if (params.hasMedia === true) args.push('--has-media');
  if (params.mediaType !== undefined)
    args.push('--type', text(params.mediaType, 'mediaType', 20));
  const data = record(await runWacli(args), 'search');
  const messages = Array.isArray(data.messages)
    ? data.messages.map((m) => messageView(record(m, 'message')))
    : [];
  return bounded({ fts: data.fts === true, messages });
}

function sourceId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 256 ||
    !/^[A-Za-z0-9@._:-]+$/.test(value)
  ) {
    throw new Error(`whatsapp: invalid ${label}`);
  }
  return value;
}

function mediaExtension(message: JsonRecord): string {
  const mime = String(message.MimeType || '')
    .toLowerCase()
    .split(';')[0];
  const byMime: Record<string, string> = {
    'audio/ogg': '.ogg',
    'audio/opus': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/wav': '.wav',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'video/mp4': '.mp4',
  };
  if (byMime[mime]) return byMime[mime];
  const filename = String(message.Filename || '');
  const extension = path.extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.bin';
}

export interface WhatsAppMediaDownload {
  hostPath: string;
  publicResult: {
    chatId: string;
    messageId: string;
    mediaPath: string;
    mediaType: string;
    mimeType: string | null;
    bytes: number;
  };
}

export async function downloadWhatsAppMedia(
  params: JsonRecord,
  groupIpcDir: string,
): Promise<WhatsAppMediaDownload> {
  const chatId = sourceId(params.chatId, 'chatId');
  const messageId = sourceId(params.messageId, 'messageId');
  const shown = record(
    await runWacli(['messages', 'show', '--chat', chatId, '--id', messageId]),
    'message',
  );
  const message = record(shown.message || shown, 'message');
  const mediaType = String(message.MediaType || '');
  if (!mediaType)
    throw new Error('whatsapp: message has no downloadable media');

  const mediaDir = path.resolve(groupIpcDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
  const filename = `whatsapp-${Date.now()}-${randomUUID().slice(0, 8)}${mediaExtension(message)}`;
  const outputPath = path.join(mediaDir, filename);
  await runWacli(
    [
      'media',
      'download',
      '--chat',
      chatId,
      '--id',
      messageId,
      '--output',
      outputPath,
    ],
    WHATSAPP_MEDIA_TIMEOUT_MS,
  );
  const linkStat = fs.lstatSync(outputPath);
  if (!linkStat.isFile() || linkStat.isSymbolicLink() || linkStat.size === 0) {
    throw new Error(
      'whatsapp: downloaded media is not a regular non-empty file',
    );
  }
  const realDir = fs.realpathSync(mediaDir);
  const realPath = fs.realpathSync(outputPath);
  const relative = path.relative(realDir, realPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fs.unlinkSync(outputPath);
    throw new Error('whatsapp: downloaded media escaped the group directory');
  }
  return {
    hostPath: realPath,
    publicResult: {
      chatId,
      messageId,
      mediaPath: `/workspace/ipc/media/${filename}`,
      mediaType,
      mimeType: message.MimeType ? String(message.MimeType) : null,
      bytes: linkStat.size,
    },
  };
}

export function serializeWhatsAppResult(value: JsonRecord): string {
  return bounded(value);
}

export function _setWhatsAppExecForTests(runner?: ExecRunner): void {
  execute = runner || productionExec;
}

function bounded(value: unknown): string {
  const output = JSON.stringify({
    untrustedExternalContent: true,
    ...record(value, 'result'),
  });
  if (Buffer.byteLength(output) > WHATSAPP_MAX_RESULT_BYTES) {
    throw new Error('whatsapp: result exceeds configured output limit');
  }
  return output;
}
