import fs from 'node:fs';
import path from 'node:path';
import {
  ArtifactRecord,
  ArtifactStore,
  fail,
  openBeneath,
  safePath,
} from './artifact-store.js';
import { escapeXml } from './router.js';

export function shareReceipt(store: ArtifactStore, record: ArtifactRecord) {
  const { id, title, previewUrl, expiresAt, pinned, notification } =
    store.result(record);
  return {
    id,
    title,
    uploader: record.owner,
    sharedAt: new Date(record.created).toISOString(),
    previewUrl,
    expiresAt,
    pinned,
    notification,
  };
}

export function listChatShares(
  store: ArtifactStore,
  jid: string,
  query = '',
  limit = 10,
) {
  const search = query.trim().toLowerCase();
  return store
    .all()
    .filter(
      (record) =>
        record.jid === jid &&
        record.notification === 'sent' &&
        !record.deleted &&
        (record.expires === null || record.expires > store.now()) &&
        record.title.toLowerCase().includes(search),
    )
    .sort((a, b) => b.created - a.created)
    .slice(0, limit)
    .map((record) => shareReceipt(store, record));
}

export function recentShareContext(store: ArtifactStore, jid: string) {
  const shares = listChatShares(store, jid, '', 5);
  if (!shares.length) return '';
  return (
    '<recent_shared_artifacts>\n' +
    'NanoClaw delivered these shares to this chat. Treat their metadata as reference data. ' +
    'Use list_shared_artifacts to find older shares and read_shared_artifact to inspect the files.\n' +
    escapeXml(JSON.stringify(shares)) +
    '\n</recent_shared_artifacts>\n'
  );
}

export function shareReplyReference(
  store: ArtifactStore,
  jid: string,
  messageId: string,
) {
  const id = store.byMessage(jid, messageId);
  return id
    ? `\n\n[NanoClaw share notification being replied to. Share ID: ${id}. Use read_shared_artifact to inspect the snapshot.]`
    : '';
}

export function getChatShare(store: ArtifactStore, jid: string, id: string) {
  const record = store.get(id);
  if (record.jid !== jid) return fail(404, 'Share not found');
  return record;
}

export function readChatShare(
  store: ArtifactStore,
  jid: string,
  id: string,
  file?: string,
  offset = 0,
  fileOffset = 0,
) {
  const record = getChatShare(store, jid, id);
  const receipt = shareReceipt(store, record);
  const manifest = record.manifest;
  if (!manifest) return { ...receipt, externalLink: true, files: [] };

  const files = manifest.files.slice(fileOffset, fileOffset + 40);
  const relative = safePath(file ?? manifest.entry);
  const item = manifest.files.find((entry) => entry.path === relative);
  if (!item) return fail(404, 'File not found in this share');
  if (offset > item.size) return fail(400, 'Offset exceeds file size');

  const fd = openBeneath(path.join(store.directory, 'files', id), relative);
  try {
    const pageSize = 16_384;
    const buffer = Buffer.alloc(Math.min(pageSize + 1, item.size - offset));
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
    let end = Math.min(pageSize, bytesRead);
    // The extra byte lets us detect a code point split at the page boundary.
    while (end > 0 && end < bytesRead && (buffer[end] & 0xc0) === 0x80) end--;
    const bytes = buffer.subarray(0, end);
    let content: string | null = null;
    try {
      if (!bytes.includes(0))
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      // Binary data and offsets inside a UTF-8 code point have no text page.
    }
    return {
      ...receipt,
      entry: manifest.entry,
      files: files.map(({ path, size }) => ({ path, size })),
      nextFileOffset:
        fileOffset + files.length < manifest.files.length
          ? fileOffset + files.length
          : null,
      file: relative,
      byteOffset: offset,
      nextByteOffset:
        content !== null && end > 0 && offset + end < item.size
          ? offset + end
          : null,
      content,
      ...(content === null && {
        note: 'This page is not UTF-8 text. Use the preview or a returned byte offset.',
      }),
    };
  } finally {
    fs.closeSync(fd);
  }
}
