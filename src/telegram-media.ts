import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveGroupIpcPath } from './group-folder.js';
import { recoveryStateDir } from './recovery.js';
import { fetchWithTimeout, withTimeout } from './timeout.js';
import { TELEGRAM_MEDIA_TIMEOUT_MS } from './config.js';

// Bound host memory use independently of Telegram's server-side limits.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface TelegramAttachment {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** Retain the download reference before acknowledging an update, even on failure. */
export async function saveTelegramAttachment(opts: {
  botToken: string;
  getFile: (id: string) => Promise<{ file_path?: string }>;
  chatJid: string;
  groupFolder: string;
  messageId: number;
  kind: 'document' | 'audio' | 'video';
  attachment: TelegramAttachment;
}): Promise<{ containerPath: string; hostPath: string; bytes: number }> {
  const mediaDir = path.join(resolveGroupIpcPath(opts.groupFolder), 'media');
  if (!Number.isSafeInteger(opts.messageId) || opts.messageId < 0)
    throw new Error('Invalid attachment message ID');
  const key = crypto.createHash('sha256').update(opts.chatJid).digest('hex');
  const evidenceDir = path.join(recoveryStateDir(), 'telegram-media', key);
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const evidencePath = path.join(evidenceDir, `${opts.messageId}.json`);
  const record = {
    chatJid: opts.chatJid,
    groupFolder: opts.groupFolder,
    messageId: opts.messageId,
    kind: opts.kind,
    attachment: opts.attachment,
  };
  const persist = (state: object) => {
    const temporary = `${evidencePath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(
        temporary,
        JSON.stringify({ ...record, ...state }, null, 2) + '\n',
        { mode: 0o600 },
      );
      fs.renameSync(temporary, evidencePath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  };
  persist({ status: 'pending' });
  let temporary: string | undefined;
  let failureCode = 'missing_file_id';
  try {
    if (!opts.attachment.file_id) throw new Error('Missing Telegram file ID');
    failureCode = 'attachment_too_large';
    if ((opts.attachment.file_size || 0) > MAX_ATTACHMENT_BYTES)
      throw new Error('Attachment exceeds 20 MiB download limit');
    failureCode = 'telegram_get_file_failed';
    const file = await withTimeout(
      opts.getFile(opts.attachment.file_id),
      TELEGRAM_MEDIA_TIMEOUT_MS,
      'Telegram attachment getFile',
    );
    failureCode = 'missing_file_path';
    if (!file.file_path) throw new Error('Telegram returned no file path');
    failureCode = 'download_failed';
    const response = await fetchWithTimeout(
      `https://api.telegram.org/file/bot${opts.botToken}/${file.file_path}`,
      TELEGRAM_MEDIA_TIMEOUT_MS,
    );
    failureCode = `http_${response.status}`;
    if (!response.ok)
      throw new Error(`Telegram attachment HTTP ${response.status}`);
    failureCode = 'missing_response_body';
    if (!response.body)
      throw new Error('Telegram attachment response has no body');
    failureCode = 'download_interrupted';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_ATTACHMENT_BYTES) {
          failureCode = 'attachment_too_large';
          throw new Error('Attachment exceeds 20 MiB download limit');
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    failureCode = 'empty_attachment';
    if (!bytes) throw new Error('Telegram attachment is empty');
    failureCode = 'size_mismatch';
    if (
      opts.attachment.file_size !== undefined &&
      bytes !== opts.attachment.file_size
    )
      throw new Error('Telegram attachment size mismatch');
    failureCode = 'media_write_failed';
    const original = path.basename(
      (opts.attachment.file_name || path.basename(file.file_path)).replaceAll(
        '\\',
        '/',
      ),
    );
    const name =
      original.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'file';
    const filename = `${opts.kind}_${opts.messageId}_${name}`;
    fs.mkdirSync(mediaDir, { recursive: true });
    const hostPath = path.join(mediaDir, filename);
    temporary = `${hostPath}.${crypto.randomUUID()}.part`;
    const buffer = Buffer.concat(chunks);
    fs.writeFileSync(temporary, buffer, { mode: 0o600 });
    fs.renameSync(temporary, hostPath);
    temporary = undefined;
    const containerPath = `/workspace/ipc/media/${filename}`;
    persist({
      status: 'downloaded',
      containerPath,
      bytes,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    });
    return { containerPath, hostPath, bytes };
  } catch {
    // Do not persist/log raw fetch errors: they can contain the bot-token URL.
    persist({ status: 'failed', errorCode: failureCode });
    throw new Error(
      `Telegram attachment download failed (${failureCode}); file reference retained in host telegram-media records`,
    );
  } finally {
    if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
