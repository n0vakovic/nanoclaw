import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;

// Voice transcription pause thresholds (seconds).
// Gaps between adjacent words longer than these get marked as [pause] / [long pause]
// in the rendered transcript, to surface mid-sentence hesitation. Pauses after
// sentence-ending punctuation are suppressed since those are natural.
export const PAUSE_THRESHOLD_S = 1.0;
export const LONG_PAUSE_THRESHOLD_S = 2.0;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Bounded-time budgets for the Telegram bot's two sequential loops (grammy
// update polling + IPC watcher). See docs/concurrency-model.md. Ordering
// matters: a media download / transcription must time out BEFORE the inbound
// handler backstop, so a stalled request degrades to fallback text and the
// message is still stored rather than being abandoned wholesale.
export const TELEGRAM_MEDIA_TIMEOUT_MS = parseInt(
  process.env.TELEGRAM_MEDIA_TIMEOUT_MS || '15000',
  10,
); // per media download (getFile + file fetch)
export const TRANSCRIPTION_TIMEOUT_MS = parseInt(
  process.env.TRANSCRIPTION_TIMEOUT_MS || '30000',
  10,
); // Whisper call; word timestamps add latency
export const TRANSCRIPTION_FALLBACK_TIMEOUT_MS = parseInt(
  process.env.TRANSCRIPTION_FALLBACK_TIMEOUT_MS || '30000',
  10,
); // Plain JSON fallback on a different transcription model
export const RETAINED_TRANSCRIPTION_TIMEOUT_MS = parseInt(
  process.env.RETAINED_TRANSCRIPTION_TIMEOUT_MS || '45000',
  10,
); // Explicit host-side retry; still bounded for interactive use
export const TELEGRAM_API_TIMEOUT_MS = parseInt(
  process.env.TELEGRAM_API_TIMEOUT_MS || '30000',
  10,
); // every outbound bot.api.* call
export const TELEGRAM_HANDLER_TIMEOUT_MS = parseInt(
  process.env.TELEGRAM_HANDLER_TIMEOUT_MS || '90000',
  10,
); // inbound handler backstop; must exceed media + transcription budgets

// Hard timeout for outbound fetch() calls in host-actions (GitHub, Todoist,
// ElevenLabs, xAI-adjacent integrations). Node's global fetch has no default
// timeout, so a stalled connection would hang the host action indefinitely.
export const HOST_ACTION_FETCH_TIMEOUT_MS = parseInt(
  process.env.HOST_ACTION_FETCH_TIMEOUT_MS || '30000',
  10,
);

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
export const HOME_DIR = process.env.HOME || os.homedir();
export const CODING_DIR = path.join(HOME_DIR, 'coding');
export const SYNC_DIR = path.join(HOME_DIR, 'damrassbot', 'sync');

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const GITHUB_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'github-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
