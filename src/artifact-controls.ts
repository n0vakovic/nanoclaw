import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ArtifactStore, fail, openBeneath } from './artifact-store.js';
import { readEnvFile } from './env.js';
import { NewMessage, RegisteredGroup } from './types.js';

function gh(args: string[], input?: unknown): Promise<unknown> {
  const env = readEnvFile(['ARTIFACTS_GH_BIN', 'ARTIFACTS_GIST_ENABLED']);
  if (
    (process.env.ARTIFACTS_GIST_ENABLED ?? env.ARTIFACTS_GIST_ENABLED) !== '1'
  )
    return Promise.reject(new Error('Gist promotion is not enabled'));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.ARTIFACTS_GH_BIN ?? env.ARTIFACTS_GH_BIN ?? 'gh',
      ['api', ...args],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) child.kill('SIGKILL');
      else out += chunk;
    });
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('GitHub command unavailable'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(new Error('GitHub request failed or timed out'));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error('Invalid GitHub response'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}
export interface Promotion {
  state: 'creating' | 'uncertain' | 'published';
  marker: string;
  url?: string;
  previewUrl?: string;
  requester: string;
  at: number;
}
const inFlight = new Set<string>();
export async function promote(
  store: ArtifactStore,
  id: string,
  visibility: 'secret' | 'public',
  requester: string,
  call = gh,
) {
  const key = id + visibility;
  if (inFlight.has(key)) fail(409, 'Promotion is already in progress');
  inFlight.add(key);
  try {
    const row = store.db
      .prepare('SELECT record FROM promotions WHERE id=? AND visibility=?')
      .get(id, visibility) as { record: string } | undefined;
    let operation: Promotion | undefined = row
      ? JSON.parse(row.record)
      : undefined;
    if (operation?.state === 'published') return operation;
    const r = store.get(id);
    if (!r.manifest) fail(400, 'Forwarded links cannot be promoted');
    const save = (op: Promotion) =>
      store.db
        .prepare('INSERT OR REPLACE INTO promotions VALUES (?,?,?)')
        .run(id, visibility, JSON.stringify(op));
    if (operation) {
      // Reconcile uncertain side effects; never create a second gist blindly.
      for (let page = 1; page <= 10; page++) {
        const entries = (await call([`gists?per_page=100&page=${page}`])) as {
          description: string;
          html_url: string;
          public: boolean;
        }[];
        const found = entries.find(
          (g) =>
            g.description?.includes(operation!.marker) &&
            g.public === (visibility === 'public'),
        );
        if (found) {
          operation = { ...operation, state: 'published', url: found.html_url };
          save(operation);
          return operation;
        }
        if (entries.length < 100) break;
      }
      fail(
        409,
        'Previous GitHub outcome is uncertain. No duplicate was created; inspect GitHub and reconcile the promotion record.',
      );
    }
    const files: Record<string, { content: string }> = Object.create(null);
    let total = 0;
    for (const f of r.manifest!.files) {
      if (f.path.includes('/'))
        fail(
          400,
          'Gists require flat text files; folder assets are not supported',
        );
      if (
        !/\.(html?|txt|md|csv|json|css|js|ts|py|sh|yaml|yml|xml|log)$/i.test(
          f.path,
        )
      )
        fail(400, 'Unsupported gist file type');
      total += f.size;
      if (total > 1024 * 1024)
        fail(413, 'Gist promotion supports up to 1 MiB of text');
      const fd = openBeneath(path.join(store.directory, 'files', r.id), f.path);
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(
          fs.readFileSync(fd),
        );
      } finally {
        fs.closeSync(fd);
      }
      if (!content! || content!.includes('\0'))
        fail(400, 'Gist files must be nonempty UTF-8 text');
      if (/\.html?$/i.test(f.path)) {
        const references = [
          ...content!.matchAll(
            /\b(?:src|href|srcset|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
          ),
        ];
        const linked = references.some(
          (m) => !/^(?:data:|#)/i.test(m[1] ?? m[2] ?? m[3]),
        );
        const cssReferences = [
          ...content!.matchAll(
            /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/gi,
          ),
        ];
        const linkedCss = cssReferences.some(
          (m) => !/^(?:data:|#)/i.test(m[1] ?? m[2] ?? m[3]),
        );
        if (
          linked ||
          linkedCss ||
          /@import\b|\bfetch\s*\(|\bimport(?:\s|\()/i.test(content!)
        )
          fail(
            400,
            'HTML gist promotion requires self-contained HTML without linked assets',
          );
      }
      files[f.path] = { content: content! };
    }
    const marker = `[nanoclaw:${id}:${visibility}]`;
    operation = { state: 'creating', marker, requester, at: store.now() };
    save(operation);
    try {
      const gist = (await call(['gists', '--method', 'POST', '--input', '-'], {
        description: `${r.title} ${marker}`,
        public: visibility === 'public',
        files,
      })) as { html_url?: string };
      if (!gist.html_url?.startsWith('https://gist.github.com/'))
        throw new Error('Invalid gist result');
      operation = { ...operation, state: 'published', url: gist.html_url };
      if (r.manifest!.files.length === 1 && /\.html?$/i.test(r.manifest!.entry))
        operation.previewUrl = `https://htmlpreview.github.io/?${gist.html_url}/raw/${encodeURIComponent(r.manifest!.entry)}`;
      save(operation);
      return operation;
    } catch {
      operation.state = 'uncertain';
      save(operation);
      return fail(
        502,
        'GitHub publication outcome is uncertain. Retry to reconcile; no automatic duplicate will be created.',
      );
    }
  } finally {
    inFlight.delete(key);
  }
}
export function parseShareIntent(
  text: string,
): { action: string; visibility?: 'secret' | 'public' } | undefined {
  const t = text.trim().toLowerCase().replace(/[.!]$/, '');
  if (t === 'keep this' || t === 'pin this') return { action: 'pin' };
  if (t === 'unpin this') return { action: 'unpin' };
  if (t === 'delete this share') return { action: 'delete' };
  const m = /^publish this as a (secret|public) gist$/.exec(t);
  if (m) return { action: 'publish', visibility: m[1] as 'secret' | 'public' };
  if (t === 'publish this' || t === 'publish this as a gist')
    return { action: 'clarify' };
}
export async function artifactControl(
  store: ArtifactStore,
  groups: Record<string, RegisteredGroup>,
  jid: string,
  msg: NewMessage,
  args: string,
) {
  const owner = Object.entries(groups).find(
    ([key, g]) => g.isMain && /^tg:[1-9][0-9]*$/.test(key),
  );
  if (
    !owner ||
    jid !== owner[0] ||
    msg.sender !== jid.slice(3) ||
    msg.is_bot_message
  )
    fail(403, 'Share controls require the owner in the private main chat');
  let action: string, id: string | undefined, visibility: string | undefined;
  const natural = parseShareIntent(args);
  if (natural) {
    action = natural.action;
    visibility = natural.visibility;
    id = msg.reply_to_message_id
      ? store.byMessage(jid, msg.reply_to_message_id)
      : undefined;
  } else {
    [action, id, visibility] = args.trim().split(/\s+/);
  }
  if (!id)
    return {
      reply:
        'Reply to a share notification, or use /share status|pin|unpin|delete ID, or /share publish ID secret|public.',
    };
  const r = store.get(id);
  if (r.jid !== jid) fail(403, 'Share belongs to a different destination');
  if (
    action === 'clarify' ||
    (action === 'publish' && !['secret', 'public'].includes(visibility ?? ''))
  )
    return {
      reply:
        'Choose secret (anyone with the link) or public gist: /share publish ' +
        id +
        ' secret|public',
    };
  if (action === 'pin' || action === 'unpin')
    return {
      reply: JSON.stringify(
        store.result(store.pin(id, action === 'pin')),
        null,
        2,
      ),
    };
  if (action === 'delete') {
    store.remove(id);
    return {
      reply: 'Share deleted. Original files and published gists are unchanged.',
    };
  }
  if (action === 'status')
    return { reply: JSON.stringify(store.result(r), null, 2) };
  if (action === 'publish') {
    const result = await promote(
      store,
      id,
      visibility as 'secret' | 'public',
      msg.sender,
    );
    return {
      reply: `${visibility === 'secret' ? 'Secret gist (anyone with the link)' : 'Public gist'}: ${result.url}${result.previewUrl ? '\nExternal HTML preview: ' + result.previewUrl : ''}`,
    };
  }
  return {
    reply:
      'Usage: /share status|pin|unpin|delete ID, or /share publish ID secret|public',
  };
}
