import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveIpc = vi.hoisted(() => vi.fn());
vi.mock('./group-folder.js', () => ({ resolveGroupIpcPath: resolveIpc }));
import { saveTelegramAttachment } from './telegram-media.js';

let directory: string;
let getFile: ReturnType<
  typeof vi.fn<(id: string) => Promise<{ file_path?: string }>>
>;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-media-'));
  vi.stubEnv('NANOCLAW_STATE_DIR', path.join(directory, 'state'));
  resolveIpc.mockReturnValue(path.join(directory, 'ipc'));
  getFile = vi
    .fn<(id: string) => Promise<{ file_path?: string }>>()
    .mockResolvedValue({ file_path: 'documents/file.pdf' });
  fetchMock = vi.fn().mockImplementation(async () => new Response('%PDF-test'));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});
function save(overrides = {}) {
  return saveTelegramAttachment({
    botToken: 'secret-token',
    getFile,
    chatJid: 'tg:1',
    groupFolder: 'test',
    messageId: 42,
    kind: 'document',
    attachment: {
      file_id: 'telegram-reference',
      file_name: 'report.pdf',
      file_size: 9,
    },
    ...overrides,
  });
}
function evidence() {
  const root = path.join(directory, 'state/telegram-media');
  const folder = fs.readdirSync(root)[0];
  return JSON.parse(
    fs.readFileSync(path.join(root, folder, '42.json'), 'utf8'),
  );
}

describe('Telegram attachments', () => {
  it('downloads actual bytes and retains a recoverable reference outside agent mounts', async () => {
    const saved = await save();
    expect(saved.containerPath).toBe(
      '/workspace/ipc/media/document_42_report.pdf',
    );
    expect(fs.readFileSync(saved.hostPath, 'utf8')).toBe('%PDF-test');
    expect(fs.statSync(saved.hostPath).mode & 0o777).toBe(0o600);
    expect(evidence()).toMatchObject({
      status: 'downloaded',
      attachment: { file_id: 'telegram-reference' },
      bytes: 9,
    });
    expect(JSON.stringify(evidence())).not.toContain('secret-token');
  });
  it('sanitizes path traversal and keeps duplicate filenames from different messages separate', async () => {
    const first = await save({
      attachment: { file_id: 'id', file_name: '../../report.pdf' },
    });
    const second = await save({
      messageId: 43,
      attachment: { file_id: 'id', file_name: 'C:\\folder\\report.pdf' },
    });
    expect(path.dirname(first.hostPath)).toBe(
      path.join(directory, 'ipc/media'),
    );
    expect(first.hostPath).not.toBe(second.hostPath);
    expect(fs.readFileSync(first.hostPath, 'utf8')).toBe('%PDF-test');
  });
  it('keeps failed references without handing an HTTP error page to the agent', async () => {
    fetchMock.mockResolvedValue(new Response('not a file', { status: 404 }));
    await expect(save()).rejects.toThrow('http_404');
    expect(evidence()).toMatchObject({
      status: 'failed',
      errorCode: 'http_404',
      attachment: { file_id: 'telegram-reference' },
    });
    expect(
      fs.existsSync(path.join(directory, 'ipc/media/document_42_report.pdf')),
    ).toBe(false);
  });
  it('rejects truncated downloads and can retry the same reference successfully', async () => {
    fetchMock.mockResolvedValueOnce(new Response('%PDF'));
    await expect(save()).rejects.toThrow('size_mismatch');
    expect(evidence().status).toBe('failed');
    await save();
    expect(evidence().status).toBe('downloaded');
  });
  it('rejects declared oversized files before fetching and retains the reference', async () => {
    await expect(
      save({ attachment: { file_id: 'id', file_size: 21 * 1024 * 1024 } }),
    ).rejects.toThrow('attachment_too_large');
    expect(getFile).not.toHaveBeenCalled();
    expect(evidence().status).toBe('failed');
  });
  it('does not leak token-bearing fetch errors in the thrown error or evidence', async () => {
    fetchMock.mockRejectedValue(
      new Error('https://api.telegram.org/file/botsecret-token/file'),
    );
    await expect(save()).rejects.toThrow('download_failed');
    expect(JSON.stringify(evidence())).not.toContain('secret-token');
  });
});
