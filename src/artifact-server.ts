import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import Busboy from 'busboy';
import {
  ArtifactStore,
  ArtifactError,
  ArtifactRecord,
  Manifest,
  digest,
  fail,
  safePath,
  openBeneath,
} from './artifact-store.js';
import { readEnvFile } from './env.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
export interface ArtifactConfig {
  directory: string;
  apiOrigin: string;
  previewOrigin: string;
  apiPort: number;
  previewPort: number;
  ttlDays?: number;
  quota?: number;
  maxBytes?: number;
}
export function artifactConfig(): ArtifactConfig | undefined {
  const keys = [
    'ARTIFACTS_ENABLED',
    'ARTIFACTS_DIRECTORY',
    'ARTIFACTS_API_ORIGIN',
    'ARTIFACTS_PREVIEW_ORIGIN',
    'ARTIFACTS_API_PORT',
    'ARTIFACTS_PREVIEW_PORT',
    'ARTIFACTS_TTL_DAYS',
    'ARTIFACTS_QUOTA_BYTES',
    'ARTIFACTS_MAX_BYTES',
  ];
  const file = readEnvFile(keys);
  const env = (key: string) => process.env[key] ?? file[key];
  if (env('ARTIFACTS_ENABLED') !== '1') return;
  const origin = (key: string) => {
    const u = new URL(env(key) || '');
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.pathname !== '/' ||
      u.search ||
      u.hash
    )
      fail(400, `Invalid ${key}`);
    return u.origin;
  };
  const number = (key: string, def: number, max: number) => {
    const n = Number(env(key) ?? def);
    if (!Number.isSafeInteger(n) || n < 1 || n > max)
      fail(400, `Invalid ${key}`);
    return n;
  };
  const c = {
    directory:
      env('ARTIFACTS_DIRECTORY') ??
      path.join(os.homedir(), '.local/share/nanoclaw/artifacts'),
    apiOrigin: origin('ARTIFACTS_API_ORIGIN'),
    previewOrigin: origin('ARTIFACTS_PREVIEW_ORIGIN'),
    apiPort: number('ARTIFACTS_API_PORT', 8787, 65535),
    previewPort: number('ARTIFACTS_PREVIEW_PORT', 8788, 65535),
    ttlDays: number('ARTIFACTS_TTL_DAYS', 7, 30),
    quota: number('ARTIFACTS_QUOTA_BYTES', 2 * 1024 ** 3, 100 * 1024 ** 3),
    maxBytes: number('ARTIFACTS_MAX_BYTES', 50 * 1024 ** 2, 1024 ** 3),
  };
  if (c.apiOrigin === c.previewOrigin || c.apiPort === c.previewPort)
    fail(400, 'Upload and preview must have different origins and ports');
  return c;
}
async function jsonBody(req: http.IncomingMessage) {
  let length = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 65536) fail(413, 'Request too large');
    parts.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString());
  } catch {
    return fail(400, 'Invalid JSON');
  }
}
function respond(res: http.ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}
export class ArtifactService {
  store: ArtifactStore;
  api: http.Server;
  preview: http.Server;
  busy = false;
  notifying = false;
  timers: NodeJS.Timeout[] = [];
  constructor(public config: ArtifactConfig) {
    this.store = new ArtifactStore({
      ...config,
      previewOrigin: config.previewOrigin,
    });
    this.api = http.createServer((req, res) => {
      void this.handleApi(req, res).catch((e) => this.error(res, e));
    });
    this.preview = http.createServer((req, res) => {
      void this.handlePreview(req, res).catch((e) => this.error(res, e));
    });
    for (const server of [this.api, this.preview]) {
      server.requestTimeout = 120000;
      server.headersTimeout = 15000;
      server.maxHeadersCount = 50;
    }
  }
  error(res: http.ServerResponse, e: unknown) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    respond(res, e instanceof ArtifactError ? e.status : 400, {
      error: e instanceof ArtifactError ? e.message : 'Request failed',
    });
  }
  async start(
    send: (jid: string, text: string) => Promise<string | undefined>,
  ) {
    const listen = (s: http.Server, p: number) =>
      new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.listen(p, '127.0.0.1', () => {
          s.off('error', reject);
          resolve();
        });
      });
    await listen(this.api, this.config.apiPort);
    try {
      await listen(this.preview, this.config.previewPort);
    } catch (e) {
      this.api.close();
      throw e;
    }
    const notify = async () => {
      if (this.notifying) return;
      this.notifying = true;
      try {
        await this.store.notify(send);
      } finally {
        this.notifying = false;
      }
    };
    this.timers = [
      setInterval(() => {
        void notify();
      }, 5000),
      setInterval(() => this.store.sweep(), 3600000),
    ];
    void notify();
  }
  async close() {
    this.timers.forEach(clearInterval);
    for (const s of [this.api, this.preview]) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    } /* DB remains open until process shutdown for in-flight notification completion. */
  }
  async handleApi(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.headers.origin) fail(403, 'Browser API requests are not supported');
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
      req.headers.authorization ?? '',
    )?.[1];
    const credential = token ? this.store.authenticate(token) : undefined;
    if (!credential) fail(401, 'Invalid upload credential');
    const u = new URL(req.url ?? '/', 'http://localhost');
    const owner = credential!.client;
    if (req.method === 'GET' && u.pathname === '/v1/health') {
      respond(res, 200, {
        protocol: 1,
        maxBytes: this.store.maxBytes,
        maxFiles: 1000,
        previewOrigin: this.config.previewOrigin,
      });
      return;
    }
    const match = /^\/v1\/artifacts\/([a-f0-9]{36})$/.exec(u.pathname);
    if (match) {
      if (req.method === 'GET') {
        respond(res, 200, this.store.result(this.store.get(match[1], owner)));
        return;
      }
      if (req.method === 'DELETE') {
        this.store.remove(match[1], owner);
        respond(res, 200, { deleted: true });
        return;
      }
      if (req.method === 'PATCH') {
        const b = await jsonBody(req);
        if (typeof b.pinned !== 'boolean' || Object.keys(b).length !== 1)
          fail(400, 'Expected pinned boolean');
        respond(
          res,
          200,
          this.store.result(this.store.pin(match[1], b.pinned, owner)),
        );
        return;
      }
    }
    if (
      req.method === 'POST' &&
      (u.pathname === '/v1/artifacts' || u.pathname === '/v1/links')
    ) {
      if (this.busy) fail(429, 'Another upload is in progress; retry shortly');
      this.busy = true;
      try {
        const key = String(req.headers['idempotency-key'] ?? '');
        this.store.key(key);
        let r: ArtifactRecord;
        if (u.pathname === '/v1/links') {
          const b = await jsonBody(req);
          if (
            typeof b.url !== 'string' ||
            b.url.length > 2048 ||
            typeof b.title !== 'string' ||
            !b.title.trim() ||
            b.title.length > 200 ||
            Object.keys(b).some((k) => !['url', 'title'].includes(k))
          )
            fail(400, 'Expected url and title');
          const url = new URL(b.url);
          if (url.protocol !== 'https:' || url.username || url.password)
            fail(400, 'Only HTTPS links without credentials are supported');
          r = this.store.create(
            owner,
            credential!.jid,
            key,
            null,
            undefined,
            url.href,
            b.title,
          );
        } else r = await this.upload(req, owner, credential!.jid, key);
        respond(res, 201, this.store.result(r));
      } finally {
        this.busy = false;
      }
      return;
    }
    fail(404, 'Endpoint not found');
  }
  async upload(
    req: http.IncomingMessage,
    owner: string,
    jid: string,
    key: string,
  ) {
    const dir = fs.mkdtempSync(
      path.join(this.store.directory, 'staging', 'upload-'),
    );
    let manifest: Manifest | undefined;
    let error: unknown;
    let total = 0;
    const seen = new Set<string>();
    const jobs: Promise<void>[] = [];
    try {
      const parser = Busboy({
        headers: req.headers,
        limits: {
          files: 1000,
          fields: 1,
          fieldSize: 512 * 1024,
          fileSize: this.store.maxBytes,
          parts: 1001,
          headerPairs: 20,
        },
      });
      parser.on('field', (name, value, info) => {
        try {
          if (name !== 'manifest' || manifest || info.valueTruncated)
            fail(400, 'Send one manifest before files');
          manifest = this.store.validate(JSON.parse(value));
          this.store.capacity(manifest.files.reduce((n, f) => n + f.size, 0));
        } catch (e) {
          error = e;
        }
      });
      parser.on('file', (name, stream) => {
        try {
          if (error || !manifest) fail(400, 'Manifest must precede files');
          const index = Number(name);
          if (!/^\d+$/.test(name) || !Number.isSafeInteger(index))
            fail(400, 'File part must be its manifest index');
          const f = manifest!.files[index];
          if (!f || seen.has(f.path)) fail(400, 'Unexpected or duplicate file');
          seen.add(f.path);
          fs.mkdirSync(path.dirname(path.join(dir, f.path)), {
            recursive: true,
            mode: 0o700,
          });
          const hash = createHash('sha256');
          let size = 0;
          stream.on('limit', () => {
            error = new ArtifactError(413, 'File too large');
          });
          const check = new Transform({
            transform(chunk, _encoding, callback) {
              size += chunk.length;
              total += chunk.length;
              if (size > f.size || total > thisService.store.maxBytes)
                callback(
                  new ArtifactError(413, 'Upload size exceeds manifest'),
                );
              else {
                hash.update(chunk);
                callback(null, chunk);
              }
            },
          });
          const thisService = this;
          const output = fs.createWriteStream(path.join(dir, f.path), {
            flags: 'wx',
            mode: 0o600,
          });
          jobs.push(
            pipeline(stream, check, output)
              .then(() => {
                if (size !== f.size || hash.digest('hex') !== f.sha256)
                  fail(400, 'File size or checksum mismatch');
                const fd = fs.openSync(path.join(dir, f.path), 'r');
                try {
                  fs.fsyncSync(fd);
                } finally {
                  fs.closeSync(fd);
                }
              })
              .catch((e) => {
                error = e;
              }),
          );
        } catch (e) {
          error = e;
          stream.resume();
        }
      });
      for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit'])
        parser.on(event, () => {
          error = new ArtifactError(413, 'Too many upload parts');
        });
      let wire = 0;
      const wireLimit = this.store.maxBytes + 2 * 1024 * 1024;
      await pipeline(
        req,
        new Transform({
          transform(chunk, _encoding, cb) {
            wire += chunk.length;
            cb(
              wire > wireLimit
                ? new ArtifactError(413, 'Request too large')
                : null,
              chunk,
            );
          },
        }),
        parser,
      );
      await Promise.all(jobs);
      if (error) throw error;
      if (!manifest || seen.size !== manifest.files.length)
        fail(400, 'Upload is incomplete');
      return this.store.create(owner, jid, key, manifest!, dir);
    } finally {
      await Promise.all(jobs);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  async handlePreview(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!['GET', 'HEAD'].includes(req.method ?? ''))
      fail(405, 'Read-only preview');
    // Inspect raw paths before URL normalization can erase traversal.
    const raw = (req.url ?? '').split('?')[0];
    const match = /^\/(p|d)\/([a-f0-9]{36})\/(.*)$/.exec(raw);
    if (!match) fail(404, 'Preview not found');
    const r = this.store.get(match![2]);
    if (!r.manifest) fail(404, 'No stored file');
    let relative = decodeURIComponent(match![3]);
    if (!relative || relative.endsWith('/'))
      relative += relative
        ? r.manifest!.entry.startsWith(relative)
          ? r.manifest!.entry.slice(relative.length)
          : 'index.html'
        : r.manifest!.entry;
    safePath(relative);
    if (r.manifest!.files.some((f) => f.path === relative + '/index.html')) {
      res.writeHead(308, {
        Location: `/p/${r.id}/${relative.split('/').map(encodeURIComponent).join('/')}/`,
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }
    if (!r.manifest!.files.some((f) => f.path === relative))
      fail(404, 'File not found');
    const fd = openBeneath(
      path.join(this.store.directory, 'files', r.id),
      relative,
    );
    const stat = fs.fstatSync(fd);
    const mime = MIME[path.extname(relative).toLowerCase()];
    res.writeHead(200, {
      'Content-Type': mime ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; img-src https: data:; font-src https: data:; media-src https:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
      ...(match![1] === 'd' || !mime
        ? {
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(relative))}`,
          }
        : {}),
    });
    if (req.method === 'HEAD') {
      fs.closeSync(fd);
      res.end();
      return;
    }
    await pipeline(fs.createReadStream('', { fd, autoClose: true }), res);
  }
  async shareLocal(
    root: string,
    relative: string,
    owner: string,
    jid: string,
    key: string,
    title: string,
    ttlDays?: number,
    entry?: string,
  ) {
    if (this.busy) fail(429, 'Another upload is in progress; retry shortly');
    this.busy = true;
    const dir = fs.mkdtempSync(
      path.join(this.store.directory, 'staging', 'local-'),
    );
    try {
      safePath(relative);
      const sourceFd = openBeneath(root, relative, true);
      const files: Manifest['files'] = [];
      let total = 0;
      const copy = (fd: number, name: string) => {
        const st = fs.fstatSync(fd);
        if (st.isDirectory()) {
          for (const child of fs.readdirSync(`/proc/self/fd/${fd}`).sort()) {
            safePath(child);
            const next = fs.openSync(
              `/proc/self/fd/${fd}/${child}`,
              fs.constants.O_RDONLY |
                fs.constants.O_NOFOLLOW |
                fs.constants.O_NONBLOCK,
            );
            try {
              copy(next, name ? name + '/' + child : child);
            } finally {
              fs.closeSync(next);
            }
          }
          return;
        }
        if (!st.isFile()) fail(400, 'Only regular files may be shared');
        safePath(name);
        total += st.size;
        if (total > this.store.maxBytes || files.length >= 1000)
          fail(413, 'Artifact exceeds limits');
        this.store.capacity(total);
        const bytes = Buffer.alloc(st.size);
        let offset = 0;
        while (offset < bytes.length) {
          const n = fs.readSync(
            fd,
            bytes,
            offset,
            bytes.length - offset,
            offset,
          );
          if (!n) fail(400, 'Source changed during copy');
          offset += n;
        }
        const after = fs.fstatSync(fd);
        if (after.size !== st.size || after.mtimeMs !== st.mtimeMs)
          fail(400, 'Source changed during copy');
        fs.mkdirSync(path.dirname(path.join(dir, name)), {
          recursive: true,
          mode: 0o700,
        });
        fs.writeFileSync(path.join(dir, name), bytes, { mode: 0o600 });
        const out = fs.openSync(path.join(dir, name), 'r');
        try {
          fs.fsyncSync(out);
        } finally {
          fs.closeSync(out);
        }
        files.push({ path: name, size: bytes.length, sha256: digest(bytes) });
      };
      try {
        copy(
          sourceFd,
          fs.fstatSync(sourceFd).isDirectory() ? '' : path.basename(relative),
        );
      } finally {
        fs.closeSync(sourceFd);
      }
      const m = this.store.validate({
        title,
        entry: entry ?? (files.length === 1 ? files[0].path : 'index.html'),
        ttlDays,
        files,
      });
      return this.store.result(this.store.create(owner, jid, key, m, dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      this.busy = false;
    }
  }
}
let active: ArtifactService | undefined;
export const setArtifactService = (service: ArtifactService | undefined) => {
  active = service;
};
export const getArtifactService = () =>
  active ?? fail(503, 'Artifact sharing is not enabled');
