import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ArtifactService } from './artifact-server.js';
import { digest } from './artifact-store.js';
const services: ArtifactService[] = [];
async function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-http-'));
  const s = new ArtifactService({
    directory,
    apiOrigin: 'https://api.example',
    previewOrigin: 'https://preview.example:8443',
    apiPort: 0,
    previewPort: 0,
  });
  services.push(s);
  await new Promise<void>((r) => s.api.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => s.preview.listen(0, '127.0.0.1', r));
  const port = (server: typeof s.api) =>
    (server.address() as { port: number }).port;
  const token = s.store.issue('mac', 'tg:123');
  return {
    s,
    api: `http://127.0.0.1:${port(s.api)}`,
    preview: `http://127.0.0.1:${port(s.preview)}`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': 'test-request-123',
    },
  };
}
afterEach(async () => {
  for (const s of services.splice(0)) {
    await s.close();
    s.store.close();
    fs.rmSync(s.store.directory, { recursive: true, force: true });
  }
});
function upload(content = 'hello', checksum = digest(content)) {
  const form = new FormData();
  form.append(
    'manifest',
    JSON.stringify({
      title: 'Report',
      entry: 'index.html',
      files: [
        {
          path: 'index.html',
          size: Buffer.byteLength(content),
          sha256: checksum,
        },
      ],
    }),
  );
  form.append('0', new Blob([content]), '0');
  return form;
}
it('streams uploads, isolates previews, authenticates controls and deduplicates', async () => {
  const { s, api, preview, headers } = await setup();
  expect((await fetch(api + '/v1/health')).status).toBe(401);
  expect(
    (
      await fetch(api + '/v1/health', {
        headers: { ...headers, Origin: 'https://evil' },
      })
    ).status,
  ).toBe(403);
  const response = await fetch(api + '/v1/artifacts', {
    method: 'POST',
    headers,
    body: upload(),
  });
  expect(response.status).toBe(201);
  const r = (await response.json()) as { id: string };
  const view = await fetch(preview + `/p/${r.id}/index.html`);
  expect(await view.text()).toBe('hello');
  expect(view.headers.get('Content-Security-Policy')).toContain(
    'sandbox allow-scripts;',
  );
  expect(view.headers.get('Content-Security-Policy')).not.toContain(
    'allow-same-origin',
  );
  expect(view.headers.get('Cache-Control')).toBe('no-store');
  const replay = await fetch(api + '/v1/artifacts', {
    method: 'POST',
    headers,
    body: upload(),
  });
  expect(((await replay.json()) as { id: string }).id).toBe(r.id);
  expect(s.store.all()).toHaveLength(1);
  expect((await fetch(preview + `/p/${r.id}/%2e%2e%2fsecret`)).status).toBe(
    400,
  );
  await fetch(api + `/v1/artifacts/${r.id}`, { method: 'DELETE', headers });
  expect((await fetch(preview + `/p/${r.id}/index.html`)).status).toBe(410);
});
it('rejects incorrect checksums and removes staging data', async () => {
  const { s, api, headers } = await setup();
  const result = await fetch(api + '/v1/artifacts', {
    method: 'POST',
    headers,
    body: upload('hello', digest('wrong')),
  });
  expect(result.status).toBe(400);
  expect(s.store.all()).toHaveLength(0);
  expect(fs.readdirSync(path.join(s.store.directory, 'staging'))).toEqual([]);
});
it('local folders use managed snapshots and reject symlinks', async () => {
  const { s } = await setup();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-'));
  try {
    fs.mkdirSync(path.join(root, 'site'));
    fs.writeFileSync(path.join(root, 'site/index.html'), 'ok');
    fs.writeFileSync(path.join(root, 'site/style.css'), 'body {}');
    const result = await s.shareLocal(
      root,
      'site',
      'group-main',
      'tg:123',
      'local-request-123',
      'Site',
    );
    fs.writeFileSync(path.join(root, 'site/index.html'), 'changed');
    expect(
      fs.readFileSync(
        path.join(s.store.directory, 'files', result.id, 'index.html'),
        'utf8',
      ),
    ).toBe('ok');
    fs.symlinkSync('/etc/passwd', path.join(root, 'site/secret'));
    await expect(
      s.shareLocal(
        root,
        'site',
        'group-main',
        'tg:123',
        'local-request-456',
        'Site',
      ),
    ).rejects.toThrow();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('supports pin/unpin via API and restricts other clients', async () => {
  const { s, api, headers } = await setup();
  const response = await fetch(api + '/v1/artifacts', {
    method: 'POST',
    headers,
    body: upload(),
  });
  const { id } = (await response.json()) as { id: string };
  const pin = await fetch(api + `/v1/artifacts/${id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ pinned: true }),
  });
  expect(((await pin.json()) as { expiresAt: null }).expiresAt).toBeNull();
  const other = s.store.issue('other', 'tg:123');
  expect(
    (
      await fetch(api + `/v1/artifacts/${id}`, {
        headers: { Authorization: `Bearer ${other}` },
      })
    ).status,
  ).toBe(404);
  const unpin = await fetch(api + `/v1/artifacts/${id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ pinned: false }),
  });
  expect(((await unpin.json()) as { pinned: boolean }).pinned).toBe(false);
});

it('preserves forwarded link title and rejects idempotency title conflicts', async () => {
  const { api, headers } = await setup();
  const send = (title: string) =>
    fetch(api + '/v1/links', {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'https://example.com/report', title }),
    });
  const response = await send('Report');
  expect(response.status).toBe(201);
  expect(((await response.json()) as { title: string }).title).toBe('Report');
  expect((await send('Different')).status).toBe(409);
});

it('cleans interrupted uploads and releases the upload slot', async () => {
  const { s, api, headers } = await setup();
  const manifest = {
    title: 'Interrupted',
    entry: 'index.html',
    files: [{ path: 'index.html', size: 5, sha256: digest('hello') }],
  };
  const req = http.request(api + '/v1/artifacts', {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'multipart/form-data; boundary=abort-test',
    },
  });
  req.on('error', () => {});
  req.write(
    '--abort-test\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n' +
      JSON.stringify(manifest) +
      '\r\n--abort-test\r\nContent-Disposition: form-data; name="0"; filename="0"\r\nContent-Type: application/octet-stream\r\n\r\nhe',
  );
  for (let i = 0; i < 100 && !s.busy; i++)
    await new Promise((r) => setTimeout(r, 5));
  expect(s.busy).toBe(true);
  req.destroy();
  for (let i = 0; i < 100 && s.busy; i++)
    await new Promise((r) => setTimeout(r, 5));
  expect(s.busy).toBe(false);
  expect(s.store.all()).toEqual([]);
  expect(fs.readdirSync(path.join(s.store.directory, 'staging'))).toEqual([]);
});
