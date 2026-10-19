import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { readEnvFile } from './env.js';
import { fetchWithTimeout } from './timeout.js';
import { HOST_ACTION_FETCH_TIMEOUT_MS } from './config.js';

const inputSchema = z
  .object({
    limit: z.number().int().min(5).max(100).default(20),
    pagination_token: z.string().min(1).max(2048).optional(),
    since_id: z.string().regex(/^\d+$/).optional(),
    include_replies: z.boolean().default(true),
  })
  .strict();

const encode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export function xOAuthHeader(
  url: URL,
  credentials: {
    consumerKey: string;
    consumerSecret: string;
    token: string;
    tokenSecret: string;
  },
  nonce = randomBytes(16).toString('hex'),
  timestamp = String(Math.floor(Date.now() / 1000)),
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_token: credentials.token,
    oauth_nonce: nonce,
    oauth_timestamp: timestamp,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_version: '1.0',
  };
  const parameters = [...Object.entries(oauth), ...url.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)])
    .sort(([ak, av], [bk, bv]) =>
      ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
    )
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const base = `GET&${encode(url.origin + url.pathname)}&${encode(parameters)}`;
  oauth.oauth_signature = createHmac(
    'sha1',
    `${encode(credentials.consumerSecret)}&${encode(credentials.tokenSecret)}`,
  )
    .update(base)
    .digest('base64');
  return (
    'OAuth ' +
    Object.entries(oauth)
      .map(([k, v]) => `${encode(k)}="${encode(v)}"`)
      .join(', ')
  );
}

export async function readXAccount(
  kind: 'tweets' | 'bookmarks',
  params: Record<string, unknown> = {},
): Promise<string> {
  const input = inputSchema.parse(params);
  if (
    kind === 'bookmarks' &&
    (input.since_id || params.include_replies !== undefined)
  ) {
    throw new Error(
      'Bookmarks do not support since_id or include_replies; use pagination_token.',
    );
  }
  const names = [
    'X_CONSUMER_KEY',
    'X_CONSUMER_SECRET',
    'X_SECRET_KEY',
    'X_ACCESS_TOKEN',
    'X_ACCESS_TOKEN_SECRET',
    'X_USER_ID',
  ];
  const file = readEnvFile(names);
  const get = (name: string) => process.env[name] || file[name];
  const credentials = {
    consumerKey: get('X_CONSUMER_KEY') || '',
    consumerSecret: get('X_CONSUMER_SECRET') || get('X_SECRET_KEY') || '',
    token: get('X_ACCESS_TOKEN') || '',
    tokenSecret: get('X_ACCESS_TOKEN_SECRET') || '',
  };
  const userId = get('X_USER_ID');
  if (
    Object.values(credentials).some((v) => !v) ||
    !userId ||
    !/^\d+$/.test(userId)
  ) {
    throw new Error(
      'X user authorization is not configured. Set X_CONSUMER_KEY, X_CONSUMER_SECRET (or X_SECRET_KEY), X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET and X_USER_ID on the host.',
    );
  }
  const url = new URL(`https://api.x.com/2/users/${userId}/${kind}`);
  // X can omit next_token on max_results=100 even when older bookmarks
  // exist. A 50-item page was verified to paginate beyond that false end.
  const pageSize =
    kind === 'bookmarks' ? Math.min(input.limit, 50) : input.limit;
  url.searchParams.set('max_results', String(pageSize));
  url.searchParams.set(
    'tweet.fields',
    'created_at,author_id,entities,note_tweet,referenced_tweets,conversation_id',
  );
  if (input.pagination_token)
    url.searchParams.set('pagination_token', input.pagination_token);
  if (kind === 'tweets') {
    url.searchParams.set(
      'exclude',
      input.include_replies ? 'retweets' : 'retweets,replies',
    );
    if (input.since_id) url.searchParams.set('since_id', input.since_id);
  }
  const response = await fetchWithTimeout(
    url.toString(),
    HOST_ACTION_FETCH_TIMEOUT_MS,
    {
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: xOAuthHeader(url, credentials) },
    },
  );
  if (!response.ok) {
    const hint =
      response.status === 401
        ? 'Reauthorize the X account.'
        : response.status === 402
          ? 'Check X API credits.'
          : response.status === 403
            ? 'Check app permissions and account access.'
            : response.status === 429
              ? `Rate limited; retry after ${response.headers.get('x-rate-limit-reset') || 'the rate-limit window'} (Unix seconds when supplied).`
              : 'Try again later.';
    throw new Error(`X ${kind} failed (HTTP ${response.status}). ${hint}`);
  }
  const result = (await response.json()) as {
    data?: Array<{
      id: string;
      text: string;
      note_tweet?: { text?: string };
      [key: string]: unknown;
    }>;
    meta?: Record<string, unknown>;
    errors?: unknown;
  };
  return JSON.stringify({
    account_id: userId,
    collection: kind,
    page_size: pageSize,
    fetched_at: new Date().toISOString(),
    posts: (result.data || []).map((post) => ({
      ...post,
      text: post.note_tweet?.text || post.text,
      url: `https://x.com/i/status/${post.id}`,
    })),
    meta: result.meta || { result_count: 0 },
    ...(result.errors ? { errors: result.errors } : {}),
  });
}
