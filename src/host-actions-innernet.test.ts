import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { _setInnernetClockForTests, dispatchAction } from './host-actions.js';

const BASE = 'https://api.innernet.znachilo.com';
const NOW = Date.parse('2026-11-08T12:00:00Z');
const HOUR = 3_600_000;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[];
let routes: Array<(call: Call) => Response | undefined>;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const call: Call = {
    url,
    method: init?.method ?? 'GET',
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
  calls.push(call);
  for (const route of routes) {
    const res = route(call);
    if (res) return res;
  }
  return new Response(`no route for ${call.method} ${url}`, { status: 500 });
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

function route(
  method: string,
  match: (url: URL) => boolean,
  respond: (call: Call) => Response,
): void {
  routes.push((call) =>
    call.method === method && match(new URL(call.url))
      ? respond(call)
      : undefined,
  );
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function log(
  id: number,
  text: string,
  timestamp: string,
  updated_at?: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    timestamp,
    text,
    tags: 'ritual',
    reflection: '',
    voice_url: null,
    visibility: 'private',
    ...(updated_at !== undefined ? { updated_at } : {}),
    ...extra,
  };
}

async function run(params: Record<string, unknown>) {
  return dispatchAction(
    { type: 'action', action: 'innernet', requestId: 'r1', params } as never,
    { sourceGroup: 'telegram_main', groupIpcDir: '/tmp/ipc', isMain: true },
  );
}

async function runOk(params: Record<string, unknown>) {
  const res = await run(params);
  if (!res.ok) throw new Error(`action failed: ${res.output}`);
  return JSON.parse(res.output);
}

beforeEach(() => {
  calls = [];
  routes = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('INNERNET_ADMIN_TOKEN', 'test-token');
  _setInnernetClockForTests(() => NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _setInnernetClockForTests();
});

describe('innernet read', () => {
  it('passes filters as encoded query params', async () => {
    route(
      'GET',
      (u) => u.pathname === '/logs',
      () => json([]),
    );
    await runOk({
      op: 'read',
      q: '🧘 a&b',
      tag: 'ritual',
      since: '2026-11-01T00:00:00Z',
      until: '2026-11-08T00:00:00Z',
      limit: 1,
    });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('q')).toBe('🧘 a&b');
    expect(url.searchParams.get('tag')).toBe('ritual');
    expect(url.searchParams.get('since')).toBe('2026-11-01T00:00:00Z');
    expect(url.searchParams.get('until')).toBe('2026-11-08T00:00:00Z');
    expect(url.searchParams.get('limit')).toBe('1');
    expect(calls[0].url).not.toContain('🧘');
    expect(calls[0].headers.Authorization).toBe('Bearer test-token');
  });

  it('defaults limit to 50 and omits unset filters', async () => {
    route(
      'GET',
      (u) => u.pathname === '/logs',
      () => json([{ id: 1 }]),
    );
    const out = await runOk({ op: 'read' });
    expect(out).toEqual([{ id: 1 }]);
    expect(calls[0].url).toBe(`${BASE}/logs?limit=50`);
  });

  it('surfaces API errors', async () => {
    route(
      'GET',
      (u) => u.pathname === '/logs',
      () => new Response('bad since', { status: 400 }),
    );
    const res = await run({ op: 'read', since: 'nope' });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('Innernet 400: bad since');
  });
});

describe('innernet get', () => {
  it('fetches a single entry by id', async () => {
    route(
      'GET',
      (u) => u.pathname === '/logs/42',
      () => json(log(42, '🧘 yoga', '2026-11-08T10:00:00')),
    );
    const out = await runOk({ op: 'get', id: 42 });
    expect(out.id).toBe(42);
  });

  it('requires an id', async () => {
    const res = await run({ op: 'get' });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('missing params.id');
  });
});

describe('innernet update', () => {
  it('PUTs only the provided fields (replace semantics)', async () => {
    route(
      'PUT',
      (u) => u.pathname === '/logs/7',
      (call) => json({ id: 7, ...(call.body as object) }),
    );
    const out = await runOk({
      op: 'update',
      id: 7,
      reflection: 'full corrected notes',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].body).toEqual({ reflection: 'full corrected notes' });
    expect(calls[0].headers.Authorization).toBe('Bearer test-token');
    expect(out.reflection).toBe('full corrected notes');
  });

  it('allows clearing the reflection with an empty string', async () => {
    route(
      'PUT',
      (u) => u.pathname === '/logs/7',
      (call) => json({ id: 7, ...(call.body as object) }),
    );
    await runOk({ op: 'update', id: 7, reflection: '', visibility: 'public' });
    expect(calls[0].body).toEqual({ reflection: '', visibility: 'public' });
  });

  it('rejects invalid visibility', async () => {
    const res = await run({ op: 'update', id: 7, visibility: 'secret' });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('invalid visibility');
    expect(calls).toHaveLength(0);
  });

  it('requires at least one field', async () => {
    const res = await run({ op: 'update', id: 7 });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('at least one of');
    expect(calls).toHaveLength(0);
  });

  it('requires an id', async () => {
    const res = await run({ op: 'update', reflection: 'x' });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('missing params.id');
  });
});

describe('innernet ritual', () => {
  function lookup(results: unknown[]): void {
    route(
      'GET',
      (u) => u.pathname === '/logs',
      () => json(results),
    );
  }

  function acceptCreate(id = 100): void {
    route(
      'POST',
      (u) => u.pathname === '/log',
      () => json({ status: 'ok', id }, 201),
    );
    route(
      'GET',
      (u) => u.pathname === `/logs/${id}`,
      () => {
        const post = calls.find((c) => c.method === 'POST')!;
        return json({ id, ...(post.body as object), updated_at: iso(NOW) });
      },
    );
  }

  it('queries by emoji with the ritual tag', async () => {
    lookup([]);
    acceptCreate();
    await runOk({ op: 'ritual', emoji: '🧘' });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/logs');
    expect(url.searchParams.get('q')).toBe('🧘');
    expect(url.searchParams.get('tag')).toBe('ritual');
  });

  it('creates a private ritual entry when none exists', async () => {
    lookup([]);
    acceptCreate(100);
    const out = await runOk({
      op: 'ritual',
      emoji: '🧘',
      name: 'morning sit',
      reflection: 'calm',
    });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe(`${BASE}/log`);
    expect(post.body).toEqual({
      text: '🧘 morning sit',
      tags: 'ritual',
      reflection: 'calm',
      visibility: 'private',
      timestamp: iso(NOW),
    });
    expect(out.id).toBe(100);
    expect(out.created).toBe(true);
    expect(out.entry.id).toBe(100);
    expect(out.previous).toBeNull();
    expect(out.hoursSincePrevious).toBeNull();
  });

  it('uses just the emoji as text when no name is given', async () => {
    lookup([]);
    acceptCreate();
    await runOk({ op: 'ritual', emoji: '🧘' });
    const post = calls.find((c) => c.method === 'POST')!;
    expect((post.body as { text: string }).text).toBe('🧘');
  });

  it('continues the newest entry inside the window and replaces notes', async () => {
    const current = log(5, '🧘 sit', iso(NOW - 2 * HOUR), iso(NOW - 1 * HOUR));
    const older = log(4, '🧘 sit', iso(NOW - 26 * HOUR), iso(NOW - 25 * HOUR));
    lookup([current, older]);
    route(
      'PUT',
      (u) => u.pathname === '/logs/5',
      (call) => json({ ...current, ...(call.body as object) }),
    );
    const out = await runOk({
      op: 'ritual',
      emoji: '🧘',
      reflection: 'full notes v2',
    });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toEqual({ reflection: 'full notes v2' });
    expect(out.id).toBe(5);
    expect(out.created).toBe(false);
    expect(out.entry.reflection).toBe('full notes v2');
    expect(out.previous).toEqual({
      id: 4,
      timestamp: older.timestamp,
      updated_at: older.updated_at,
    });
    expect(out.hoursSincePrevious).toBe(26);
  });

  it('continues without writing when no notes are given', async () => {
    const current = log(5, '🧘', iso(NOW - HOUR), iso(NOW - HOUR));
    lookup([current]);
    const out = await runOk({ op: 'ritual', emoji: '🧘' });
    expect(calls).toHaveLength(1);
    expect(out.created).toBe(false);
    expect(out.entry).toEqual(current);
    expect(out.previous).toBeNull();
    expect(out.hoursSincePrevious).toBeNull();
  });

  it('measures the window from updated_at, not timestamp', async () => {
    // Started 10h ago but touched 30 min ago: still the current session.
    const current = log(5, '🧘', iso(NOW - 10 * HOUR), iso(NOW - HOUR / 2));
    lookup([current]);
    const out = await runOk({ op: 'ritual', emoji: '🧘' });
    expect(out.created).toBe(false);
  });

  it('creates a new entry once the window has passed', async () => {
    const last = log(5, '🧘 sit', iso(NOW - 30 * HOUR), iso(NOW - 4 * HOUR));
    lookup([last]);
    acceptCreate(6);
    const out = await runOk({ op: 'ritual', emoji: '🧘', name: 'sit' });
    expect(out.created).toBe(true);
    expect(out.id).toBe(6);
    expect(out.previous).toEqual({
      id: 5,
      timestamp: last.timestamp,
      updated_at: last.updated_at,
    });
    expect(out.hoursSincePrevious).toBe(30);
  });

  it('honours a custom windowHours', async () => {
    const last = log(5, '🧘', iso(NOW - 2 * HOUR), iso(NOW - 2 * HOUR));
    lookup([last]);
    acceptCreate(6);
    const out = await runOk({ op: 'ritual', emoji: '🧘', windowHours: 1 });
    expect(out.created).toBe(true);
  });

  it('falls back to a naive timestamp (as UTC) when updated_at is missing', async () => {
    // Naive "2026-11-08T10:30:00" is 1.5h before NOW in UTC.
    const current = log(5, '🧘', '2026-11-08T10:30:00');
    lookup([current]);
    const out = await runOk({ op: 'ritual', emoji: '🧘' });
    expect(out.created).toBe(false);

    calls = [];
    routes = [];
    const stale = log(5, '🧘', '2026-11-08T08:30:00');
    lookup([stale]);
    acceptCreate(6);
    const out2 = await runOk({ op: 'ritual', emoji: '🧘' });
    expect(out2.created).toBe(true);
    expect(out2.hoursSincePrevious).toBe(3.5);
  });

  it('ignores matches whose text does not start with the emoji', async () => {
    // q also matches reflections: another ritual mentioning ☕ is not a ☕ session.
    const other = log(9, '🧘 sit', iso(NOW - HOUR), iso(NOW - HOUR), {
      reflection: 'then ☕ after',
    });
    lookup([other]);
    acceptCreate(10);
    const out = await runOk({ op: 'ritual', emoji: '☕' });
    expect(out.created).toBe(true);
    expect(out.previous).toBeNull();
  });

  it('treats emoji with and without a variation selector as the same', async () => {
    const current = log(5, '☕️ coffee', iso(NOW - HOUR), iso(NOW - HOUR));
    lookup([current]);
    const out = await runOk({ op: 'ritual', emoji: '☕' });
    expect(out.created).toBe(false);
    expect(new URL(calls[0].url).searchParams.get('q')).toBe('☕');
  });

  it('requires an emoji', async () => {
    const res = await run({ op: 'ritual', name: 'sit' });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('missing params.emoji');
    expect(calls).toHaveLength(0);
  });
});
