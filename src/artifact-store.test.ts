import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ArtifactStore,
  digest,
  safePath,
  openBeneath,
} from './artifact-store.js';
import { artifactControl, promote } from './artifact-controls.js';
const stores: ArtifactStore[] = [];
const roots: string[] = [];
function setup(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-test-'));
  roots.push(root);
  const store = new ArtifactStore({
    directory: root,
    previewOrigin: 'https://preview.example:8443',
    ...extra,
  });
  stores.push(store);
  return store;
}
function add(
  store: ArtifactStore,
  key = 'request-123',
  content = 'hello',
  filename = 'index.html',
) {
  const m = store.validate({
    title: 'Report',
    entry: filename,
    files: [
      {
        path: filename,
        size: Buffer.byteLength(content),
        sha256: digest(content),
      },
    ],
  });
  const dir = fs.mkdtempSync(path.join(store.directory, 'staging', 'test-'));
  fs.writeFileSync(path.join(dir, filename), content);
  return store.create('mac', 'tg:123', key, m, dir);
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const r of roots.splice(0))
    fs.rmSync(r, { recursive: true, force: true });
});
describe('artifact store', () => {
  it('hashes credentials and restricts ownership', () => {
    const s = setup();
    const token = s.issue('mac', 'tg:123');
    expect(s.authenticate(token)).toEqual({ client: 'mac', jid: 'tg:123' });
    expect(s.authenticate('bad')).toBeUndefined();
    const r = add(s);
    expect(() => s.get(r.id, 'other')).toThrow('not found');
    expect(
      fs
        .readFileSync(path.join(s.directory, 'artifacts.db'))
        .includes(Buffer.from(token)),
    ).toBe(false);
  });
  it('deduplicates, rejects conflicts, and does not resurrect deleted submissions', () => {
    const s = setup();
    const r = add(s);
    expect(add(s).id).toBe(r.id);
    expect(() => add(s, 'request-123', 'changed')).toThrow('conflicts');
    s.remove(r.id);
    expect(() => add(s)).toThrow('deleted');
  });
  it('expires on reads, preserves pins, unpins with fresh TTL, and enforces quota', () => {
    let now = 1_000_000;
    const s = setup({ now: () => now, quota: 10 });
    const a = add(s);
    const b = add(s, 'request-456');
    s.pin(b.id, true);
    now += 8 * 86400000;
    expect(() => s.get(a.id)).toThrow('expired');
    s.sweep();
    expect(fs.existsSync(path.join(s.directory, 'files', a.id))).toBe(false);
    expect(s.get(b.id).pinned).toBe(true);
    expect(() => add(s, 'request-789', '123456')).toThrow('full');
    const unpinned = s.pin(b.id, false);
    expect(unpinned.expires).toBe(now + 7 * 86400000);
  });
  it('retries failed notifications after restart without another upload', async () => {
    let now = 1_000_000;
    const s = setup({ now: () => now });
    const r = add(s);
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue('321');
    await s.notify(send);
    expect(s.get(r.id).notification).toBe('pending');
    now += 120000;
    await s.notify(send);
    expect(s.byMessage('tg:123', '321')).toBe(r.id);
    await s.notify(send);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('rejects traversal, secrets, duplicate and file/directory collisions', () => {
    for (const p of ['../x', '/tmp/x', 'a\\b', '.env', 'a/.git/config', 'a//x'])
      expect(() => safePath(p)).toThrow();
    const s = setup();
    for (const names of [
      ['A', 'a'],
      ['a', 'a/b'],
    ])
      expect(() =>
        s.validate({
          title: 'x',
          entry: names[0],
          files: names.map((p) => ({ path: p, size: 0, sha256: digest('') })),
        }),
      ).toThrow();
  });
  it('refuses symlink components in host reads', () => {
    const s = setup();
    fs.symlinkSync('/tmp', path.join(s.directory, 'link'));
    expect(() => openBeneath(s.directory, 'link/file')).toThrow();
  });
  it('preserves tombstones and pin state across restart; cleans orphans', () => {
    const s = setup();
    const r = add(s);
    s.pin(r.id, true);
    const root = s.directory;
    s.close();
    stores.splice(stores.indexOf(s), 1);
    fs.mkdirSync(path.join(root, 'staging', 'incomplete'));
    const fresh = new ArtifactStore({
      directory: root,
      previewOrigin: 'https://preview.example',
    });
    stores.push(fresh);
    expect(fresh.get(r.id).pinned).toBe(true);
    expect(fs.readdirSync(path.join(root, 'staging'))).toEqual([]);
  });
});
describe('owner controls and publication', () => {
  const groups = {
    'tg:123': {
      name: 'owner',
      folder: 'main',
      trigger: '',
      added_at: '',
      isMain: true,
    },
  };
  const msg = {
    id: '1',
    chat_jid: 'tg:123',
    sender: '123',
    sender_name: 'owner',
    content: '',
    timestamp: '',
  };
  it('authorizes real sender and stored reply mapping', async () => {
    const s = setup();
    const r = add(s);
    r.messageId = '55';
    s.save(r);
    await expect(
      artifactControl(
        s,
        groups,
        'tg:123',
        { ...msg, sender: '456' },
        `delete ${r.id}`,
      ),
    ).rejects.toThrow('owner');
    await artifactControl(
      s,
      groups,
      'tg:123',
      { ...msg, reply_to_message_id: '55' },
      'keep this',
    );
    expect(s.get(r.id).pinned).toBe(true);
  });
  it('publishes immutable snapshots once and preserves gist after local deletion', async () => {
    const s = setup();
    const r = add(s);
    const call = vi
      .fn()
      .mockResolvedValue({ html_url: 'https://gist.github.com/test/abc' });
    const result = await promote(s, r.id, 'secret', '123', call);
    expect(result?.url).toContain('/abc');
    expect(call.mock.calls[0][1].public).toBe(false);
    await promote(s, r.id, 'secret', '123', call);
    expect(call).toHaveBeenCalledTimes(1);
    s.remove(r.id);
    expect(s.db.prepare('SELECT count(*) AS n FROM promotions').get()).toEqual({
      n: 1,
    });
  });
  it('reconciles uncertain publication instead of repeating creation', async () => {
    const s = setup();
    const r = add(s);
    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValue([
        {
          description: `[nanoclaw:${r.id}:public]`,
          html_url: 'https://gist.github.com/test/abc',
          public: true,
        },
      ]);
    await expect(promote(s, r.id, 'public', '123', call)).rejects.toThrow(
      'uncertain',
    );
    const result = await promote(s, r.id, 'public', '123', call);
    expect(result?.state).toBe('published');
    expect(call.mock.calls[1][0][0]).toContain('gists?');
  });
  it('rejects non-self-contained HTML before GitHub is called', async () => {
    const s = setup();
    const r = add(s, 'request-123', '<img src="photo.png">');
    const call = vi.fn();
    await expect(promote(s, r.id, 'secret', '123', call)).rejects.toThrow(
      'self-contained',
    );
    expect(call).not.toHaveBeenCalled();
  });
});
