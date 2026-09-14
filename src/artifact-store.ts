import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';

export class ArtifactError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (status: number, message: string): never => {
  throw new ArtifactError(status, message);
};
export const digest = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
export function safePath(value: string): string {
  if (
    !value ||
    value.length > 512 ||
    /[\\\x00-\x1f\x7f]/.test(value) ||
    value.normalize('NFC') !== value
  )
    return fail(400, 'Invalid file path');
  const parts = value.split('/');
  if (
    parts.some(
      (p) =>
        !p ||
        p === '.' ||
        p === '..' ||
        p.length > 200 ||
        p.startsWith('.') ||
        /^(node_modules|id_rsa|id_ed25519)$/i.test(p) ||
        /\.(pem|key)$/i.test(p),
    )
  )
    return fail(400, 'Hidden, secret, or unsafe file path');
  return value;
}
export const manifestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    entry: z.string().max(512),
    ttlDays: z.number().int().min(1).max(30).optional(),
    source: z
      .object({
        machine: z.string().max(100).optional(),
        project: z.string().max(100).optional(),
        session: z.string().max(200).optional(),
      })
      .strict()
      .optional(),
    files: z
      .array(
        z
          .object({
            path: z.string(),
            size: z.number().int().nonnegative(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();
export type Manifest = z.infer<typeof manifestSchema>;
export interface ArtifactRecord {
  id: string;
  owner: string;
  jid: string;
  title: string;
  manifest: Manifest | null;
  url: string | null;
  created: number;
  expires: number | null;
  pinned: boolean;
  deleted: number | null;
  bytes: number;
  notification: 'pending' | 'sent' | 'failed';
  attempts: number;
  next: number;
  messageId?: string;
  error?: string;
}
export interface StoreOptions {
  directory: string;
  previewOrigin: string;
  maxBytes?: number;
  quota?: number;
  ttlDays?: number;
  now?: () => number;
}
export class ArtifactStore {
  db: Database.Database;
  readonly directory: string;
  readonly maxBytes: number;
  readonly quota: number;
  readonly ttlDays: number;
  readonly now: () => number;
  constructor(public options: StoreOptions) {
    this.directory = options.directory;
    this.maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
    this.quota = options.quota ?? 2 * 1024 ** 3;
    this.ttlDays = options.ttlDays ?? 7;
    this.now = options.now ?? Date.now;
    for (const name of ['', 'files', 'staging'])
      fs.mkdirSync(path.join(this.directory, name), {
        recursive: true,
        mode: 0o700,
      });
    this.db = new Database(path.join(this.directory, 'artifacts.db'));
    fs.chmodSync(path.join(this.directory, 'artifacts.db'), 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, owner TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(owner,key));
      CREATE TABLE IF NOT EXISTS credentials (hash TEXT PRIMARY KEY, client TEXT NOT NULL, jid TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS promotions (id TEXT NOT NULL, visibility TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(id,visibility));`);
    // Only one host process owns this store; clear incomplete uploads after a crash.
    for (const name of fs.readdirSync(path.join(this.directory, 'staging')))
      fs.rmSync(path.join(this.directory, 'staging', name), {
        recursive: true,
        force: true,
      });
    const ids = new Set(
      (
        this.db.prepare('SELECT id FROM artifacts').all() as { id: string }[]
      ).map((r) => r.id),
    );
    for (const name of fs.readdirSync(path.join(this.directory, 'files')))
      if (!ids.has(name))
        fs.rmSync(path.join(this.directory, 'files', name), {
          recursive: true,
          force: true,
        });
    this.sweep();
  }
  issue(client: string, jid: string) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(client) || !/^tg:[1-9][0-9]*$/.test(jid))
      fail(400, 'Invalid client or private Telegram destination');
    const previous = this.db
      .prepare('SELECT jid FROM credentials WHERE client=?')
      .get(client) as { jid: string } | undefined;
    if (previous && previous.jid !== jid)
      fail(409, 'Client label already belongs to another destination');
    const token = randomBytes(32).toString('base64url');
    this.db
      .prepare('INSERT INTO credentials VALUES (?,?,?)')
      .run(digest(token), client, jid);
    return token;
  }
  authenticate(token: string) {
    return this.db
      .prepare('SELECT client,jid FROM credentials WHERE hash=?')
      .get(digest(token)) as { client: string; jid: string } | undefined;
  }
  validate(input: unknown): Manifest {
    const parsed = manifestSchema.safeParse(input);
    if (!parsed.success) return fail(400, 'Invalid artifact manifest');
    const m = parsed.data;
    safePath(m.entry);
    const seen = new Set<string>();
    for (const f of m.files) {
      safePath(f.path);
      const p = f.path.toLowerCase();
      if (seen.has(p)) fail(400, 'Duplicate file path');
      seen.add(p);
    }
    for (const p of seen) {
      const parts = p.split('/');
      parts.pop();
      while (parts.length) {
        if (seen.has(parts.join('/')))
          fail(400, 'File/directory path collision');
        parts.pop();
      }
    }
    if (!m.files.some((f) => f.path === m.entry))
      fail(400, 'Entry file is missing');
    if (m.files.reduce((n, f) => n + f.size, 0) > this.maxBytes)
      fail(413, 'Artifact exceeds size limit');
    return m;
  }
  key(key: string) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key))
      fail(
        400,
        'Idempotency-Key must contain 8–128 letters, digits, underscores or hyphens',
      );
  }
  replay(owner: string, key: string, hash: string) {
    this.key(key);
    const row = this.db
      .prepare('SELECT hash,record FROM artifacts WHERE owner=? AND key=?')
      .get(owner, key) as { hash: string; record: string } | undefined;
    if (!row) return;
    if (row.hash !== hash)
      fail(409, 'Idempotency key conflicts with a different submission');
    const r = JSON.parse(row.record) as ArtifactRecord;
    this.alive(r);
    return r;
  }
  all() {
    return (
      this.db.prepare('SELECT record FROM artifacts').all() as {
        record: string;
      }[]
    ).map((r) => JSON.parse(r.record) as ArtifactRecord);
  }
  save(r: ArtifactRecord) {
    this.db
      .prepare('UPDATE artifacts SET record=? WHERE id=?')
      .run(JSON.stringify(r), r.id);
  }
  get(id: string, owner?: string) {
    const row = this.db
      .prepare('SELECT record FROM artifacts WHERE id=?')
      .get(id) as { record: string } | undefined;
    if (!row) return fail(404, 'Share not found');
    const r = JSON.parse(row.record) as ArtifactRecord;
    if (owner && r.owner !== owner) fail(404, 'Share not found');
    this.alive(r);
    return r;
  }
  alive(r: ArtifactRecord) {
    if (
      r.deleted ||
      (!r.pinned && r.expires !== null && r.expires <= this.now())
    )
      fail(410, 'Share expired or deleted');
  }
  capacity(bytes: number) {
    this.sweep();
    if (
      this.all()
        .filter((r) => !r.deleted)
        .reduce((n, r) => n + r.bytes, 0) +
        bytes >
      this.quota
    )
      fail(413, 'Artifact storage is full; delete shares or increase quota');
  }
  create(
    owner: string,
    jid: string,
    key: string,
    m: Manifest | null,
    staging?: string,
    url?: string,
    title?: string,
  ) {
    const hash = digest(JSON.stringify(m ?? { url, title }));
    const existing = this.replay(owner, key, hash);
    if (existing) return existing;
    const bytes = m?.files.reduce((n, f) => n + f.size, 0) ?? 0;
    this.capacity(bytes);
    const id = randomBytes(18).toString('hex');
    const now = this.now();
    const r: ArtifactRecord = {
      id,
      owner,
      jid,
      title: m?.title ?? title ?? 'Shared link',
      manifest: m,
      url: url ?? null,
      created: now,
      expires: now + (m?.ttlDays ?? this.ttlDays) * 86400000,
      pinned: false,
      deleted: null,
      bytes,
      notification: 'pending',
      attempts: 0,
      next: now,
    };
    if (staging) {
      const syncTree = (directory: string) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
          if (entry.isDirectory()) syncTree(path.join(directory, entry.name));
        const fd = fs.openSync(directory, 'r');
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      };
      syncTree(staging);
      fs.renameSync(staging, path.join(this.directory, 'files', id));
      for (const directory of ['files', 'staging']) {
        const fd = fs.openSync(path.join(this.directory, directory), 'r');
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
    }
    this.db
      .prepare('INSERT INTO artifacts VALUES (?,?,?,?,?)')
      .run(id, owner, key, hash, JSON.stringify(r));
    return r;
  }
  pin(id: string, pinned: boolean, owner?: string) {
    const r = this.get(id, owner);
    r.pinned = pinned;
    r.expires = pinned ? null : this.now() + this.ttlDays * 86400000;
    this.save(r);
    return r;
  }
  remove(id: string, owner?: string) {
    const r = this.get(id, owner);
    r.deleted = this.now();
    r.notification = r.notification === 'pending' ? 'failed' : r.notification;
    r.error = 'Share deleted';
    this.save(r);
    fs.rmSync(path.join(this.directory, 'files', id), {
      recursive: true,
      force: true,
    });
  }
  sweep() {
    for (const r of this.all()) {
      if (
        !r.deleted &&
        !r.pinned &&
        r.expires !== null &&
        r.expires <= this.now()
      ) {
        r.deleted = this.now();
        if (r.notification === 'pending') {
          r.notification = 'failed';
          r.error = 'Share expired';
        }
        this.save(r);
      }
      if (r.deleted) {
        fs.rmSync(path.join(this.directory, 'files', r.id), {
          recursive: true,
          force: true,
        });
        if (r.deleted < this.now() - 30 * 86400000)
          this.db.prepare('DELETE FROM artifacts WHERE id=?').run(r.id);
      }
    }
  }
  result(r: ArtifactRecord) {
    return {
      id: r.id,
      title: r.title,
      previewUrl:
        r.url ??
        `${this.options.previewOrigin}/p/${r.id}/${r.manifest!.entry.split('/').map(encodeURIComponent).join('/')}`,
      downloadUrl:
        r.manifest?.files.length === 1
          ? `${this.options.previewOrigin}/d/${r.id}/${encodeURIComponent(r.manifest.entry)}`
          : undefined,
      expiresAt: r.expires ? new Date(r.expires).toISOString() : null,
      pinned: r.pinned,
      notification: r.notification,
      error: r.error,
      gists: this.db
        .prepare('SELECT visibility,record FROM promotions WHERE id=?')
        .all(r.id),
    };
  }
  async notify(
    send: (jid: string, text: string) => Promise<string | undefined>,
  ) {
    for (const candidate of this.all().filter(
      (r) => !r.deleted && r.notification === 'pending' && r.next <= this.now(),
    )) {
      try {
        this.alive(candidate);
        const result = this.result(candidate);
        const messageId = await send(
          candidate.jid,
          `${candidate.title}\nShare: ${candidate.id}\n${candidate.manifest?.source ? 'From: ' + Object.values(candidate.manifest.source).join(' · ') + '\n' : ''}Open preview: ${result.previewUrl}\n${candidate.pinned ? 'Pinned' : `Expires: ${result.expiresAt}`}\nReply: keep this / delete this share / publish this as a secret gist`,
        );
        const r = this.get(candidate.id);
        r.notification = 'sent';
        r.messageId = messageId;
        this.save(r);
      } catch {
        const row = this.all().find((r) => r.id === candidate.id);
        if (!row || row.deleted) continue;
        row.attempts++;
        row.error = 'Telegram delivery failed';
        row.next =
          this.now() +
          Math.min(3600000, 30000 * 2 ** Math.min(row.attempts, 7));
        if (row.attempts >= 20) row.notification = 'failed';
        this.save(row);
      }
    }
  }
  byMessage(jid: string, messageId: string) {
    return this.all().find((r) => r.jid === jid && r.messageId === messageId)
      ?.id;
  }
  close() {
    this.db.close();
  }
}

// Walk from the trusted root with O_NOFOLLOW directory descriptors. This prevents
// an agent replacing a parent directory with a symlink during a host-side copy.
export function openBeneath(
  root: string,
  relative: string,
  allowDirectory = false,
) {
  safePath(relative);
  let fd = fs.openSync(
    root,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    const parts = relative.split('/');
    for (let i = 0; i < parts.length; i++) {
      const next = fs.openSync(
        `/proc/self/fd/${fd}/${parts[i]}`,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          (i < parts.length - 1
            ? fs.constants.O_DIRECTORY
            : fs.constants.O_NONBLOCK),
      );
      fs.closeSync(fd);
      fd = next;
    }
    if (
      !fs.fstatSync(fd).isFile() &&
      !(allowDirectory && fs.fstatSync(fd).isDirectory())
    )
      fail(400, 'Only regular files may be shared');
    return fd;
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}
