/**
 * Host Action Registry for NanoClaw
 *
 * Container agents request named actions by writing JSON to their IPC actions/
 * directory. The host (this module) executes the registered handler and writes
 * the result back to action-results/. The registry is the sole security boundary:
 * if it's not here, it cannot be triggered.
 */
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { CODING_DIR, GITHUB_ALLOWLIST_PATH } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { GitHubAllowlist, GitHubPermissionTier } from './types.js';

const execAsync = promisify(exec);

export interface ActionRequest {
  action: string;
  requestId: string;
  params?: Record<string, unknown>;
}

export interface ActionResult {
  requestId: string;
  ok: boolean;
  output: string;
}

type ActionHandler = (params?: Record<string, unknown>) => Promise<string>;

/* ------------------------------------------------------------------ */
/*  GitHub Issue helper utilities                                     */
/* ------------------------------------------------------------------ */

const TIER_OPS: Record<GitHubPermissionTier, Set<string>> = {
  read: new Set(['get', 'list']),
  comment: new Set(['get', 'list', 'comment']),
  write: new Set(['get', 'list', 'comment', 'create', 'close', 'reopen']),
};

const REPO_FORMAT = /^[\w.-]+\/[\w.-]+$/;

let cachedGitHubAllowlist: {
  data: GitHubAllowlist;
  mtimeMs: number;
} | null = null;

function loadGitHubAllowlist(): GitHubAllowlist | null {
  try {
    const stat = fs.statSync(GITHUB_ALLOWLIST_PATH);
    if (cachedGitHubAllowlist && cachedGitHubAllowlist.mtimeMs === stat.mtimeMs) {
      return cachedGitHubAllowlist.data;
    }
    const raw = fs.readFileSync(GITHUB_ALLOWLIST_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as GitHubAllowlist;
    if (!Array.isArray(parsed.repos)) throw new Error('repos must be an array');
    cachedGitHubAllowlist = { data: parsed, mtimeMs: stat.mtimeMs };
    return parsed;
  } catch (err) {
    cachedGitHubAllowlist = null;
    logger.warn(
      { err, path: GITHUB_ALLOWLIST_PATH },
      'github-allowlist: failed to load',
    );
    return null;
  }
}

function assertGitHubOp(repo: string, op: string): void {
  if (!REPO_FORMAT.test(repo)) {
    throw new Error(`Invalid repo format "${repo}" — expected "owner/repo"`);
  }
  const allowlist = loadGitHubAllowlist();
  if (!allowlist) throw new Error('GitHub allowlist not configured');
  const entry = allowlist.repos.find(
    (r) => r.repo.toLowerCase() === repo.toLowerCase(),
  );
  if (!entry) throw new Error(`Repo "${repo}" not in GitHub allowlist`);
  if (!TIER_OPS[entry.tier]?.has(op)) {
    throw new Error(
      `Op "${op}" not allowed for repo "${repo}" (tier: ${entry.tier})`,
    );
  }
}

async function githubApi(
  method: string,
  urlPath: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<{ text: string; hasNextPage: boolean }> {
  const res = await fetch(`https://api.github.com${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${text}`);
  const link = res.headers.get('link') || '';
  const hasNextPage = link.includes('rel="next"');
  return { text, hasNextPage };
}

/* ------------------------------------------------------------------ */

const ACTION_REGISTRY: Record<string, ActionHandler> = {
  /**
   * git pull every repo in ~/coding, excluding _third_party.
   * Skips directories that aren't git repos.
   */
  syncRepos: async () => {
    let entries: string[];
    try {
      entries = fs.readdirSync(CODING_DIR);
    } catch (err) {
      throw new Error(
        `Cannot read ${CODING_DIR}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const repos = entries.filter((f) => {
      if (f === '_third_party') return false;
      const fullPath = path.join(CODING_DIR, f);
      try {
        return (
          fs.statSync(fullPath).isDirectory() &&
          fs.existsSync(path.join(fullPath, '.git'))
        );
      } catch {
        return false;
      }
    });

    const results: string[] = [];
    for (const repo of repos) {
      try {
        const { stdout, stderr } = await execAsync('git pull', {
          cwd: path.join(CODING_DIR, repo),
        });
        const output = (stdout || stderr).trim() || 'ok';
        results.push(`${repo}: ${output}`);
        logger.info({ repo, output }, 'syncRepos: git pull');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push(`${repo}: ERROR - ${msg}`);
        logger.warn({ repo, err }, 'syncRepos: git pull failed');
      }
    }

    // CoachEx upstream mirror sync (upstream → origin for milan/* branches)
    const coachexRepo = 'CoachEx-Tennis-private';
    const syncScript = path.join(
      CODING_DIR,
      coachexRepo,
      '.milan/tools/sync_from_upstream.sh',
    );
    if (repos.includes(coachexRepo) && fs.existsSync(syncScript)) {
      try {
        const { stdout, stderr } = await execAsync(
          `bash .milan/tools/sync_from_upstream.sh --filter "milan/" --allow-dirty`,
          { cwd: path.join(CODING_DIR, coachexRepo), timeout: 120000 },
        );
        const output = (stdout || stderr).trim() || 'ok';
        results.push(`${coachexRepo} (upstream sync): ${output}`);
        logger.info(
          { repo: coachexRepo, output },
          'syncRepos: upstream mirror sync',
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push(`${coachexRepo} (upstream sync): ERROR - ${msg}`);
        logger.warn(
          { repo: coachexRepo, err },
          'syncRepos: upstream mirror sync failed',
        );
      }
    }
    return results.length > 0
      ? results.join('\n')
      : `No git repos found in ${CODING_DIR}`;
  },

  /**
   * Convert text to speech via ElevenLabs TTS API.
   * Returns path to the generated audio file.
   * params.text: text to synthesize
   * params.voice_id: ElevenLabs voice ID (falls back to ELEVENLABS_VOICE_ID env)
   * params.model_id: optional model (defaults to eleven_turbo_v2_5)
   */
  ttsSpeak: async (params) => {
    const envVars = readEnvFile(['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID']);
    const apiKey = process.env.ELEVENLABS_API_KEY || envVars.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');

    const { text, voice_id, model_id } = params as {
      text: string;
      voice_id?: string;
      model_id?: string;
    };
    if (!text) throw new Error('ttsSpeak: missing params.text');

    const voiceId =
      voice_id ||
      process.env.ELEVENLABS_VOICE_ID ||
      envVars.ELEVENLABS_VOICE_ID;
    if (!voiceId)
      throw new Error(
        'ttsSpeak: no voice_id provided and ELEVENLABS_VOICE_ID not set',
      );

    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: model_id ?? 'eleven_turbo_v2_5',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ElevenLabs ${res.status}: ${body}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const tmpPath = `/tmp/tts-${Date.now()}.mp3`;
    fs.writeFileSync(tmpPath, buffer);
    logger.info(
      { chars: text.length, voiceId, tmpPath },
      'TTS audio generated',
    );
    return JSON.stringify({ audioPath: tmpPath });
  },

  /**
   * Proxy read-only requests to the X (Twitter) API.
   * Requires X_BEARER_TOKEN env var on the host.
   * params.endpoint: X API path, e.g. "/2/tweets/search/recent"
   * params.query: key/value pairs appended as query string
   */
  xFetch: async (params) => {
    const bearerToken =
      process.env.X_BEARER_TOKEN ||
      readEnvFile(['X_BEARER_TOKEN']).X_BEARER_TOKEN;
    if (!bearerToken) throw new Error('X_BEARER_TOKEN not set');

    const { endpoint, query } = params as {
      endpoint: string;
      query?: Record<string, string>;
    };
    if (!endpoint) throw new Error('xFetch: missing params.endpoint');

    const url = new URL(`https://api.twitter.com${endpoint}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text}`);
    return text;
  },

  /**
   * Interact with GitHub Issues via the REST API.
   * Requires GITHUB_TOKEN env var on the host.
   * Permissions governed by ~/.config/nanoclaw/github-allowlist.json
   *
   * params.op: "create" | "get" | "list" | "comment" | "close" | "reopen"
   * params.repo: "owner/repo"
   * params.title: issue title (create)
   * params.body: issue/comment body (create, comment)
   * params.labels: string[] (create, list filter)
   * params.assignees: string[] (create)
   * params.issue_number: number (get, comment, close, reopen)
   * params.state: "open" | "closed" | "all" (list, default "open")
   */
  githubIssue: async (params) => {
    const token =
      process.env.GITHUB_TOKEN || readEnvFile(['GITHUB_TOKEN']).GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN not set');

    const { op, repo, title, body, labels, assignees, issue_number, state } =
      params as {
        op: string;
        repo: string;
        title?: string;
        body?: string;
        labels?: string[];
        assignees?: string[];
        issue_number?: number;
        state?: string;
      };

    if (!op) throw new Error('githubIssue: missing params.op');
    if (!repo) throw new Error('githubIssue: missing params.repo');

    // Enforce allowlist
    assertGitHubOp(repo, op);

    switch (op) {
      case 'create': {
        if (!title) throw new Error('githubIssue create: missing params.title');
        const payload: Record<string, unknown> = { title };
        if (body) payload.body = body;
        if (labels?.length) payload.labels = labels;
        if (assignees?.length) payload.assignees = assignees;
        const created = await githubApi(
          'POST',
          `/repos/${repo}/issues`,
          token,
          payload,
        );
        return created.text;
      }

      case 'get': {
        if (!issue_number)
          throw new Error('githubIssue get: missing params.issue_number');
        const got = await githubApi(
          'GET',
          `/repos/${repo}/issues/${issue_number}`,
          token,
        );
        return got.text;
      }

      case 'list': {
        const qs = new URLSearchParams();
        qs.set('state', state || 'open');
        qs.set('per_page', '100');
        if (labels?.length) qs.set('labels', labels.join(','));
        const listed = await githubApi(
          'GET',
          `/repos/${repo}/issues?${qs.toString()}`,
          token,
        );
        if (listed.hasNextPage) {
          return (
            listed.text +
            '\n\n{"_nanoclaw_note":"Showing first 100 results. Use labels or state filters to narrow."}'
          );
        }
        return listed.text;
      }

      case 'comment': {
        if (!issue_number)
          throw new Error('githubIssue comment: missing params.issue_number');
        if (!body) throw new Error('githubIssue comment: missing params.body');
        const commented = await githubApi(
          'POST',
          `/repos/${repo}/issues/${issue_number}/comments`,
          token,
          { body },
        );
        return commented.text;
      }

      case 'close': {
        if (!issue_number)
          throw new Error('githubIssue close: missing params.issue_number');
        const closed = await githubApi(
          'PATCH',
          `/repos/${repo}/issues/${issue_number}`,
          token,
          { state: 'closed' },
        );
        return closed.text;
      }

      case 'reopen': {
        if (!issue_number)
          throw new Error('githubIssue reopen: missing params.issue_number');
        const reopened = await githubApi(
          'PATCH',
          `/repos/${repo}/issues/${issue_number}`,
          token,
          { state: 'open' },
        );
        return reopened.text;
      }

      default:
        throw new Error(
          `githubIssue: unknown op "${op}". Valid: create, get, list, comment, close, reopen`,
        );
    }
  },

  /**
   * Search for nearby places via the Foursquare Places API.
   * Requires FOURSQUARE_API_KEY env var on the host.
   *
   * params.lat: latitude
   * params.lng: longitude
   * params.query: search term (e.g. "restaurants", "coffee")
   * params.radius: search radius in meters (default 500, max 100000)
   * params.limit: max results (default 5, max 50)
   */
  placesSearch: async (params) => {
    const apiKey =
      process.env.FOURSQUARE_API_KEY ||
      readEnvFile(['FOURSQUARE_API_KEY']).FOURSQUARE_API_KEY;
    if (!apiKey) throw new Error('FOURSQUARE_API_KEY not set');

    const { lat, lng, query, radius, limit } = params as {
      lat: number;
      lng: number;
      query?: string;
      radius?: number;
      limit?: number;
    };

    if (lat == null || lng == null) {
      throw new Error('placesSearch: missing params.lat and/or params.lng');
    }

    const url = new URL('https://places-api.foursquare.com/places/search');
    url.searchParams.set('ll', `${lat},${lng}`);
    if (query) url.searchParams.set('query', query);
    url.searchParams.set('radius', String(Math.min(radius || 500, 100000)));
    url.searchParams.set('limit', String(Math.min(limit || 5, 50)));

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'X-Places-Api-Version': '2025-06-17',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Foursquare ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      results: Array<{
        name: string;
        latitude?: number;
        longitude?: number;
        location: {
          formatted_address?: string;
          address?: string;
          locality?: string;
          country?: string;
        };
        categories?: Array<{ name: string }>;
      }>;
    };

    const places = data.results.map((p) => {
      const mapsLink =
        p.latitude != null && p.longitude != null
          ? `https://maps.google.com/?q=${p.latitude},${p.longitude}`
          : null;
      return {
        name: p.name,
        address:
          p.location.formatted_address ||
          p.location.address ||
          `${p.location.locality || ''}, ${p.location.country || ''}`.trim(),
        categories: (p.categories || []).map((c) => c.name),
        mapsLink,
      };
    });

    logger.info(
      { lat, lng, query, resultCount: places.length },
      'placesSearch completed',
    );
    return JSON.stringify(places);
  },
};

export async function dispatchAction(
  request: ActionRequest,
): Promise<ActionResult> {
  const handler = ACTION_REGISTRY[request.action];
  if (!handler) {
    return {
      requestId: request.requestId,
      ok: false,
      output: `Unknown action: "${request.action}". Available: ${Object.keys(ACTION_REGISTRY).join(', ')}`,
    };
  }

  try {
    const output = await handler(request.params);
    return { requestId: request.requestId, ok: true, output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { requestId: request.requestId, ok: false, output: msg };
  }
}
