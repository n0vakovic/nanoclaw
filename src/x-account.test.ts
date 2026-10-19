import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readXAccount, xOAuthHeader } from './x-account.js';
import { fetchWithTimeout } from './timeout.js';
vi.mock('./env.js', () => ({
  readEnvFile: () => ({
    X_CONSUMER_KEY: 'app',
    X_CONSUMER_SECRET: 'secret',
    X_ACCESS_TOKEN: 'token',
    X_ACCESS_TOKEN_SECRET: 'token-secret',
    X_USER_ID: '18449711',
  }),
}));
vi.mock('./timeout.js', () => ({ fetchWithTimeout: vi.fn() }));
const fetchMock = vi.mocked(fetchWithTimeout);
beforeEach(() => {
  for (const name of [
    'X_CONSUMER_KEY',
    'X_CONSUMER_SECRET',
    'X_SECRET_KEY',
    'X_ACCESS_TOKEN',
    'X_ACCESS_TOKEN_SECRET',
    'X_USER_ID',
  ])
    vi.stubEnv(name, '');
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
describe('X account reads', () => {
  it('matches the published OAuth 1.0 GET signature example', () => {
    const header = xOAuthHeader(
      new URL(
        'http://photos.example.net/photos?file=vacation.jpg&size=original',
      ),
      {
        consumerKey: 'dpf43f3p2l4k3l03',
        consumerSecret: 'kd94hf93k423kf44',
        token: 'nnch734d00sl2jdk',
        tokenSecret: 'pfkkdhi9sl3r4s00',
      },
      'kllo9940pd9333jh',
      '1191242096',
    );
    expect(header).toContain(
      'oauth_signature="tR3%2BTy81lMeYAr%2FFid0kMTYa%2FWM%3D"',
    );
  });
  it('reads authored posts, forwards cursors, and preserves long text and metadata', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: '123', text: 'short', note_tweet: { text: 'full post' } },
          ],
          meta: { next_token: 'next' },
        }),
      ),
    );
    const result = JSON.parse(
      await readXAccount('tweets', {
        limit: 5,
        since_id: '100',
        pagination_token: 'a+b',
        include_replies: false,
      }),
    );
    const [address, , options] = fetchMock.mock.calls[0];
    const url = new URL(address as string);
    expect(url.pathname).toBe('/2/users/18449711/tweets');
    expect(url.searchParams.get('exclude')).toBe('retweets,replies');
    expect(url.searchParams.get('pagination_token')).toBe('a+b');
    expect(url.searchParams.get('since_id')).toBe('100');
    expect(options).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(result.posts[0]).toMatchObject({
      text: 'full post',
      url: 'https://x.com/i/status/123',
    });
    expect(result.meta.next_token).toBe('next');
  });
  it('caps large bookmark pages and follows the returned cursor beyond page one', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: '1', text: 'first' }],
            meta: { next_token: 'older+page', result_count: 1 },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: '2', text: 'older' }],
            meta: { result_count: 1 },
          }),
        ),
      );
    const first = JSON.parse(await readXAccount('bookmarks', { limit: 100 }));
    const second = JSON.parse(
      await readXAccount('bookmarks', {
        limit: 100,
        pagination_token: first.meta.next_token,
      }),
    );
    for (const call of fetchMock.mock.calls) {
      expect(new URL(call[0] as string).searchParams.get('max_results')).toBe(
        '50',
      );
    }
    expect(
      new URL(fetchMock.mock.calls[1][0] as string).searchParams.get(
        'pagination_token',
      ),
    ).toBe('older+page');
    expect(first.page_size).toBe(50);
    expect(second.posts[0].id).toBe('2');
    expect(second.meta.next_token).toBeUndefined();
  });

  it('supports empty bookmarks without tweet-only query parameters', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ meta: { result_count: 0 } })),
    );
    expect(JSON.parse(await readXAccount('bookmarks')).posts).toEqual([]);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/2/users/18449711/bookmarks');
    expect(url.searchParams.has('exclude')).toBe(false);
  });
  it('rejects invalid and unsupported requests before fetching', async () => {
    for (const params of [
      { limit: 101 },
      { limit: 0 },
      { since_id: 'bad' },
      { endpoint: 'https://evil.test' },
      { since_id: '123' },
    ]) {
      await expect(readXAccount('bookmarks', params)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([401, 402, 403, 429, 500])(
    'returns safe errors for HTTP %i',
    async (status) => {
      fetchMock.mockResolvedValue(
        new Response('private upstream error token-secret', { status }),
      );
      await expect(readXAccount('tweets')).rejects.toThrow(`HTTP ${status}`);
      await expect(readXAccount('tweets')).rejects.not.toThrow('token-secret');
    },
  );
});
