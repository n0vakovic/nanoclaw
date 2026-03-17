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

import { CODING_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

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
