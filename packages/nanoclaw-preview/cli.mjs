#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
const args = process.argv.slice(2);
const command = args.shift();
function option(name) {
  const i = args.indexOf(name);
  if (i < 0) return;
  const value = args[i + 1];
  if (!value || value.startsWith('--'))
    throw new Error(`${name} needs a value`);
  args.splice(i, 2);
  return value;
}
function flag(name) {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}
const configPath =
  process.env.NANOCLAW_CONFIG ??
  path.join(os.homedir(), '.config/nanoclaw-preview/config.json');
function endpoint(value) {
  const u = new URL(value);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.pathname !== '/' ||
    u.search ||
    u.hash
  )
    throw new Error('Endpoint must be an HTTPS origin');
  return u.origin;
}
function readConfig() {
  let saved = {};
  if (fs.existsSync(configPath))
    saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const c = {
    endpoint: endpoint(process.env.NANOCLAW_ENDPOINT ?? saved.endpoint),
    token: process.env.NANOCLAW_TOKEN ?? saved.token,
  };
  if (!c.token) throw new Error('Run nanoclaw connect first');
  return c;
}
function safe(p) {
  if (
    !p ||
    p.length > 512 ||
    /[\\\x00-\x1f\x7f]/.test(p) ||
    p
      .split('/')
      .some(
        (x) =>
          !x ||
          x === '..' ||
          x === '.' ||
          x.startsWith('.') ||
          /^(node_modules|id_rsa|id_ed25519)$/i.test(x) ||
          /\.(pem|key)$/i.test(x),
      )
  )
    throw new Error(`Refusing hidden, secret or unsafe path: ${p}`);
}
async function request(config, route, method = 'GET', body, key) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(config.endpoint + route, {
        method,
        headers: {
          Authorization: `Bearer ${config.token}`,
          ...(key ? { 'Idempotency-Key': key } : {}),
          ...(body && !(body instanceof FormData)
            ? { 'Content-Type': 'application/json' }
            : {}),
        },
        body:
          body instanceof FormData
            ? body
            : body
              ? JSON.stringify(body)
              : undefined,
        signal: AbortSignal.timeout(120000),
        redirect: 'error',
      });
      const result = await res.json();
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if (!res.ok)
        throw Object.assign(new Error(result.error ?? `HTTP ${res.status}`), {
          permanent: true,
        });
      return result;
    } catch (e) {
      if (e.permanent || attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}
async function main() {
  if (!command || command === 'help' || command === '--help') {
    console.log(
      'nanoclaw connect HTTPS_ORIGIN --token-stdin\nnanoclaw preview FILE_OR_FOLDER [--entry index.html] [--title TITLE] [--ttl 7d] [--json]\nnanoclaw preview --url HTTPS_URL --title TITLE\nnanoclaw status|pin|unpin|delete ID [--json]\nOptional metadata: --machine LABEL --project LABEL --session ID\nConfig: NANOCLAW_CONFIG, NANOCLAW_ENDPOINT, NANOCLAW_TOKEN',
    );
    return;
  }
  if (command === 'connect') {
    if (!flag('--token-stdin'))
      throw new Error('Supply the credential through stdin with --token-stdin');
    const host = endpoint(args.shift());
    if (args.length) throw new Error('Unexpected arguments');
    const token = fs.readFileSync(0, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new Error('Invalid credential');
    const config = { endpoint: host, token };
    const health = await request(config, '/v1/health');
    if (health.protocol !== 1) throw new Error('Unsupported server protocol');
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    const temp = configPath + '.' + randomUUID();
    fs.writeFileSync(temp, JSON.stringify(config) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temp, configPath);
    console.log(`Connected to ${host}`);
    return;
  }
  const config = readConfig();
  const json = flag('--json');
  let result;
  if (command === 'preview') {
    const url = option('--url');
    const title = option('--title');
    const entry = option('--entry');
    const ttl = option('--ttl');
    const source = {
      machine: option('--machine'),
      project: option('--project'),
      session: option('--session'),
    };
    const ttlDays = ttl ? Number(/^([0-9]+)d$/.exec(ttl)?.[1]) : undefined;
    if (
      ttlDays !== undefined &&
      (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 30)
    )
      throw new Error('--ttl must be 1d through 30d');
    const key = randomUUID();
    if (url) {
      if (args.length || entry || ttl)
        throw new Error('Unexpected link arguments');
      result = await request(
        config,
        '/v1/links',
        'POST',
        { url, title: title ?? 'Shared link' },
        key,
      );
    } else {
      const input = args.shift();
      if (!input || args.length) throw new Error('Specify one file or folder');
      const root = path.resolve(input);
      const paths = [];
      let total = 0;
      async function walk(full, rel) {
        const st = fs.lstatSync(full);
        if (st.isSymbolicLink()) throw new Error('Symlinks are not supported');
        if (st.isDirectory()) {
          for (const child of fs.readdirSync(full).sort())
            await walk(path.join(full, child), rel ? rel + '/' + child : child);
          return;
        }
        if (!st.isFile()) throw new Error('Only regular files are supported');
        safe(rel);
        total += st.size;
        if (total > 50 * 1024 * 1024 || paths.length >= 1000)
          throw new Error('Upload exceeds client limit (50 MiB / 1000 files)');
        const hash = createHash('sha256');
        for await (const chunk of fs.createReadStream(full)) hash.update(chunk);
        paths.push({
          full,
          path: rel,
          size: st.size,
          sha256: hash.digest('hex'),
        });
      }
      await walk(
        root,
        fs.lstatSync(root).isDirectory() ? '' : path.basename(root),
      );
      const manifest = {
        title: title ?? path.basename(root),
        entry: entry ?? (paths.length === 1 ? paths[0].path : 'index.html'),
        ttlDays,
        source,
        files: paths.map(({ full, ...f }) => f),
      };
      if (!paths.some((f) => f.path === manifest.entry))
        throw new Error('Entry file missing; use --entry');
      const form = new FormData();
      form.append('manifest', JSON.stringify(manifest));
      for (let i = 0; i < paths.length; i++)
        form.append(String(i), await fs.openAsBlob(paths[i].full), String(i));
      console.error(`Uploading ${paths.length} files (${total} bytes)`);
      result = await request(config, '/v1/artifacts', 'POST', form, key);
    }
  } else {
    const id = args.shift();
    if (!/^[a-f0-9]{36}$/.test(id ?? '') || args.length)
      throw new Error('Specify a valid share ID');
    if (!['status', 'pin', 'unpin', 'delete'].includes(command))
      throw new Error('Unknown command');
    result = await request(
      config,
      `/v1/artifacts/${id}`,
      command === 'status' ? 'GET' : command === 'delete' ? 'DELETE' : 'PATCH',
      ['pin', 'unpin'].includes(command)
        ? { pinned: command === 'pin' }
        : undefined,
    );
  }
  console.log(
    json
      ? JSON.stringify(result)
      : result.deleted
        ? 'Share deleted'
        : `${result.previewUrl}\nID: ${result.id}\nTelegram: ${result.notification}\n${result.pinned ? 'Pinned' : 'Expires: ' + result.expiresAt}`,
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
