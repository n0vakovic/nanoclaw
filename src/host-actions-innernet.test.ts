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

async function run(params: Record<string, unknown>, action = 'innernet') {
  return dispatchAction(
    { type: 'action', action, requestId: 'r1', params } as never,
    { sourceGroup: 'telegram_other', groupIpcDir: '/tmp/ipc', isMain: false },
  );
}

async function runOk(params: Record<string, unknown>, action = 'innernet') {
  const res = await run(params, action);
  if (!res.ok) throw new Error(`action failed: ${res.output}`);
  return JSON.parse(res.output);
}

const ritual = (params: Record<string, unknown>) => run(params, 'ritual');
const ritualOk = (params: Record<string, unknown>) => runOk(params, 'ritual');

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

describe('innernet no longer has a ritual op', () => {
  it('rejects op ritual', async () => {
    const res = await run({ op: 'ritual', emoji: '🧘' });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('unknown op "ritual"');
    expect(calls).toHaveLength(0);
  });
});

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
      const post = calls.filter((c) => c.method === 'POST').at(-1)!;
      return json({ id, ...(post.body as object), updated_at: iso(NOW) });
    },
  );
}

describe('ritual start', () => {
  it('creates a private ritual entry whose text is exactly the emoji', async () => {
    lookup([]);
    acceptCreate(100);
    const out = await ritualOk({ op: 'start', emoji: ' 🧘 ', notes: 'calm' });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/logs');
    expect(url.searchParams.get('q')).toBe('🧘');
    expect(url.searchParams.get('tag')).toBe('ritual');
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe(`${BASE}/log`);
    expect(post.body).toEqual({
      text: '🧘',
      tags: 'ritual',
      reflection: 'calm',
      visibility: 'private',
      timestamp: iso(NOW),
    });
    expect(out.id).toBe(100);
    expect(out.entry.id).toBe(100);
    expect(out.previous).toBeNull();
    expect(out.hoursSincePrevious).toBeNull();
  });

  it('defaults notes to empty', async () => {
    lookup([]);
    acceptCreate();
    await ritualOk({ op: 'start', emoji: '🧘' });
    const post = calls.find((c) => c.method === 'POST')!;
    expect((post.body as { reflection: string }).reflection).toBe('');
  });

  it('creates a new entry every time, even right after a previous one', async () => {
    const justNow = log(5, '🧘', iso(NOW - 60_000), iso(NOW - 60_000));
    lookup([justNow]);
    acceptCreate(6);
    const out = await ritualOk({ op: 'start', emoji: '🧘' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(out.id).toBe(6);
    expect(out.previous).toEqual({
      id: 5,
      timestamp: justNow.timestamp,
      updated_at: justNow.updated_at,
    });
  });

  it('reports the previous session and hours since it started', async () => {
    // updated_at is ignored for the gap; timestamp is when it happened.
    const prev = log(5, '🧘', iso(NOW - 26.5 * HOUR), iso(NOW - 2 * HOUR));
    const older = log(4, '🧘', iso(NOW - 50 * HOUR), iso(NOW - 50 * HOUR));
    lookup([prev, older]);
    acceptCreate(6);
    const out = await ritualOk({ op: 'start', emoji: '🧘' });
    expect(out.previous.id).toBe(5);
    expect(out.hoursSincePrevious).toBe(26.5);
  });

  it('reads naive timestamps as UTC', async () => {
    lookup([log(5, '🧘', '2026-11-08T08:30:00')]);
    acceptCreate(6);
    const out = await ritualOk({ op: 'start', emoji: '🧘' });
    expect(out.hoursSincePrevious).toBe(3.5);
  });

  it('ignores matches whose text does not start with the emoji', async () => {
    const other = log(9, '🧘', iso(NOW - HOUR), iso(NOW - HOUR), {
      reflection: 'then ☕ after',
    });
    lookup([other]);
    acceptCreate(10);
    const out = await ritualOk({ op: 'start', emoji: '☕' });
    expect(out.previous).toBeNull();
  });

  it('treats emoji with and without a variation selector as the same', async () => {
    lookup([log(5, '☕️', iso(NOW - 2 * HOUR), iso(NOW - 2 * HOUR))]);
    acceptCreate(6);
    const out = await ritualOk({ op: 'start', emoji: '☕️' });
    expect(new URL(calls[0].url).searchParams.get('q')).toBe('☕');
    expect(out.previous.id).toBe(5);
    const post = calls.find((c) => c.method === 'POST')!;
    expect((post.body as { text: string }).text).toBe('☕️');
  });

  it('requires an emoji', async () => {
    const res = await ritual({ op: 'start' });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('missing params.emoji');
    expect(calls).toHaveLength(0);
  });
});

describe('ritual notes', () => {
  function entry(id: number, text: string, tags = 'ritual') {
    route(
      'GET',
      (u) => u.pathname === `/logs/${id}`,
      () => json({ ...log(id, text, iso(NOW - HOUR)), tags }),
    );
    route(
      'PUT',
      (u) => u.pathname === `/logs/${id}`,
      (call) =>
        json({ ...log(id, text, iso(NOW - HOUR)), ...(call.body as object) }),
    );
  }

  const putBody = () => calls.find((c) => c.method === 'PUT')!.body;

  it('replaces the notes', async () => {
    entry(7, '🧘');
    const out = await ritualOk({ op: 'notes', id: 7, notes: 'full notes v2' });
    expect(putBody()).toEqual({ reflection: 'full notes v2' });
    expect(out.reflection).toBe('full notes v2');
  });

  it('allows empty notes', async () => {
    entry(7, '🧘');
    await ritualOk({ op: 'notes', id: 7, notes: '' });
    expect(putBody()).toEqual({ reflection: '' });
  });

  it('accepts ritual among several tags', async () => {
    entry(7, '🧘', 'morning, ritual');
    await ritualOk({ op: 'notes', id: 7, notes: 'x' });
    expect(putBody()).toEqual({ reflection: 'x' });
  });

  it('refuses an entry without the ritual tag', async () => {
    entry(7, '🧘 yoga', 'rituals,yoga');
    const res = await ritual({ op: 'notes', id: 7, notes: 'x' });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('not tagged "ritual"');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('trims "emoji + words" text back to the emoji', async () => {
    entry(7, '🧘 morning sit');
    await ritualOk({ op: 'notes', id: 7, notes: 'n' });
    expect(putBody()).toEqual({ reflection: 'n', text: '🧘' });
  });

  it('keeps a ZWJ emoji whole', async () => {
    entry(7, '🧘🏽‍♂️ sit with skin tone');
    await ritualOk({ op: 'notes', id: 7, notes: 'n' });
    expect(putBody()).toEqual({ reflection: 'n', text: '🧘🏽‍♂️' });
  });

  it('keeps a run of several leading emoji together', async () => {
    entry(7, '❤️🙏✨ gratitude and aliveness');
    await ritualOk({ op: 'notes', id: 7, notes: 'n' });
    expect(putBody()).toEqual({ reflection: 'n', text: '❤️🙏✨' });
  });

  it('leaves text without a leading emoji alone', async () => {
    entry(7, 'gratitude 🙏');
    await ritualOk({ op: 'notes', id: 7, notes: 'n' });
    expect(putBody()).toEqual({ reflection: 'n' });
  });

  it('requires an id and string notes', async () => {
    const noId = await ritual({ op: 'notes', notes: 'x' });
    expect(noId.ok).toBe(false);
    expect(noId.output).toContain('missing params.id');
    const noNotes = await ritual({ op: 'notes', id: 7 });
    expect(noNotes.ok).toBe(false);
    expect(noNotes.output).toContain('notes must be a string');
    expect(calls).toHaveLength(0);
  });
});

describe('ritual history', () => {
  it('lists sessions for the emoji, newest first, filtered by starts-with', async () => {
    const a = log(9, '🧘', iso(NOW - 5 * HOUR), iso(NOW - 4 * HOUR), {
      reflection: 'x'.repeat(200),
    });
    const notMine = log(8, '☕', iso(NOW - 6 * HOUR), iso(NOW - 6 * HOUR), {
      reflection: 'after 🧘',
    });
    const b = log(7, '🧘', '2026-11-06T12:00:00');
    lookup([a, notMine, b]);
    const out = await ritualOk({ op: 'history', emoji: '🧘' });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('q')).toBe('🧘');
    expect(url.searchParams.get('tag')).toBe('ritual');
    expect(out.emoji).toBe('🧘');
    expect(out.count).toBe(2);
    expect(out.last).toEqual({ id: 9, timestamp: a.timestamp });
    expect(out.hoursSinceLast).toBe(5);
    expect(out.sessions.map((s: { id: number }) => s.id)).toEqual([9, 7]);
    expect(out.sessions[0].notesPreview).toHaveLength(120);
    expect(out.sessions[1]).toEqual({
      id: 7,
      timestamp: '2026-11-06T12:00:00',
      updated_at: null,
      notesPreview: '',
    });
  });

  it('applies the limit after filtering and caps it at 100', async () => {
    lookup([
      log(3, '🧘', iso(NOW - HOUR)),
      log(2, '🧘', iso(NOW - 2 * HOUR)),
      log(1, '🧘', iso(NOW - 3 * HOUR)),
    ]);
    const out = await ritualOk({ op: 'history', emoji: '🧘', limit: 2 });
    expect(out.count).toBe(2);
    expect(out.sessions.map((s: { id: number }) => s.id)).toEqual([3, 2]);

    calls = [];
    await ritualOk({ op: 'history', emoji: '🧘', limit: 500 });
    expect(new URL(calls[0].url).searchParams.get('limit')).toBe('100');
  });

  it('returns empty history when there are no sessions', async () => {
    lookup([]);
    const out = await ritualOk({ op: 'history', emoji: '🧘' });
    expect(out).toEqual({
      emoji: '🧘',
      count: 0,
      last: null,
      hoursSinceLast: null,
      sessions: [],
    });
  });

  it('rejects a bad limit', async () => {
    const res = await ritual({ op: 'history', emoji: '🧘', limit: 0 });
    expect(res.ok).toBe(false);
    expect(res.output).toContain('positive integer');
  });
});
