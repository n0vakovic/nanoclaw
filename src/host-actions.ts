/**
 * Host Action Registry for NanoClaw
 *
 * Container agents request named actions by writing JSON to their IPC actions/
 * directory. The host (this module) executes the registered handler and writes
 * the result back to action-results/. The registry is the sole security boundary:
 * if it's not here, it cannot be triggered.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

import {
  DATA_DIR,
  GITHUB_ALLOWLIST_PATH,
  GROUPS_DIR,
  HOST_ACTION_FETCH_TIMEOUT_MS,
  RETAINED_TRANSCRIPTION_TIMEOUT_MS,
} from './config.js';
import { readEnvFile } from './env.js';
import { fetchWithTimeout } from './timeout.js';
import { logger } from './logger.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import {
  acknowledgeIntergroupInboxItem,
  createIntergroupInboxItem,
  listIntergroupInboxItems,
  parseInboxItemId,
  queueIntergroupInboxNotification,
} from './intergroup-inbox.js';
import { runSyncRepos } from './sync-action.js';
import {
  GitHubAllowlist,
  GitHubPermissionTier,
  RegisteredGroup,
} from './types.js';
import { transcribeAudio } from './transcription.js';

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

/**
 * Per-request context plumbed from the IPC dispatcher.
 * sourceGroup: which group's IPC dir originated this action.
 * groupIpcDir: host-side absolute path to that group's IPC dir
 *   (mounted into the container at /workspace/ipc).
 * Handlers that need to write container-readable files use groupIpcDir.
 */
export interface ActionContext {
  sourceGroup: string;
  groupIpcDir: string;
  isMain?: boolean;
  registeredGroups?: () => Record<string, RegisteredGroup>;
  updateRegisteredGroup?: (jid: string, group: RegisteredGroup) => void;
}

type ActionHandler = (
  params?: Record<string, unknown>,
  ctx?: ActionContext,
) => Promise<string>;

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
    if (
      cachedGitHubAllowlist &&
      cachedGitHubAllowlist.mtimeMs === stat.mtimeMs
    ) {
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
  const res = await fetchWithTimeout(
    `https://api.github.com${urlPath}`,
    HOST_ACTION_FETCH_TIMEOUT_MS,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${text}`);
  const link = res.headers.get('link') || '';
  const hasNextPage = link.includes('rel="next"');
  return { text, hasNextPage };
}

/* ------------------------------------------------------------------ */
/*  Main-only memory/admin helper utilities                            */
/* ------------------------------------------------------------------ */

const DEFAULT_MEMORY_FILE = 'CLAUDE.md';
const MEMORY_FILE_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
]);

function assertMain(ctx?: ActionContext): asserts ctx is ActionContext {
  if (!ctx?.isMain) {
    throw new Error('This host action is restricted to the main group');
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

function resolveMemoryFile(baseDir: string, file?: unknown): string {
  const rel =
    typeof file === 'string' && file.trim() ? file.trim() : DEFAULT_MEMORY_FILE;
  if (path.isAbsolute(rel) || rel.includes('\\')) {
    throw new Error(`Invalid memory file path "${rel}"`);
  }
  const parts = rel.split('/');
  if (
    parts.some(
      (part) => !part || part === '.' || part === '..' || part.startsWith('.'),
    )
  ) {
    throw new Error(`Invalid memory file path "${rel}"`);
  }
  if (!MEMORY_FILE_EXTENSIONS.has(path.extname(rel).toLowerCase())) {
    throw new Error(
      `Unsupported memory file extension "${path.extname(rel)}". Allowed: ${Array.from(MEMORY_FILE_EXTENSIONS).join(', ')}`,
    );
  }
  const resolved = path.resolve(baseDir, rel);
  ensureWithinBase(baseDir, resolved);
  return resolved;
}

function backupFileIfPresent(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const backupRoot = path.join(DATA_DIR, 'admin-memory-backups');
  fs.mkdirSync(backupRoot, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rel = path.relative(GROUPS_DIR, filePath).replace(/[\\/]/g, '__');
  const backupPath = path.join(backupRoot, `${timestamp}__${rel}`);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

function auditAdminMemory(
  action: string,
  ctx: ActionContext | undefined,
  details: Record<string, unknown>,
): void {
  const auditPath = path.join(DATA_DIR, 'admin-memory-audit.jsonl');
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.appendFileSync(
    auditPath,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      action,
      sourceGroup: ctx?.sourceGroup,
      ...details,
    }) + '\n',
  );
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function findRegisteredGroupByFolder(
  ctx: ActionContext,
  groupFolder: string,
): { jid: string; group: RegisteredGroup } {
  const groups = ctx.registeredGroups?.() || {};
  const entry = Object.entries(groups).find(
    ([, group]) => group.folder === groupFolder,
  );
  if (!entry)
    throw new Error(`No registered group found for folder "${groupFolder}"`);
  return { jid: entry[0], group: entry[1] };
}

function parseGroupFolder(value: unknown): string {
  if (typeof value !== 'string' || !isValidGroupFolder(value)) {
    throw new Error(`Invalid group folder "${String(value)}"`);
  }
  return value;
}

function parsePositiveInt(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid positive integer "${String(value)}"`);
  }
  return Math.min(parsed, max);
}

function resolveGroupSessionDir(groupFolder: string): string {
  const sessionsBase = path.resolve(DATA_DIR, 'sessions');
  const projectDir = path.resolve(
    sessionsBase,
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
  );
  ensureWithinBase(sessionsBase, projectDir);
  return projectDir;
}

function resolveSessionJsonlFile(
  projectDir: string,
  sessionFile?: unknown,
): string {
  if (typeof sessionFile === 'string' && sessionFile.trim()) {
    const file = sessionFile.trim();
    if (
      path.basename(file) !== file ||
      file.includes('\\') ||
      file.includes('..') ||
      !file.endsWith('.jsonl')
    ) {
      throw new Error(`Invalid session file "${file}"`);
    }
    const resolved = path.resolve(projectDir, file);
    ensureWithinBase(projectDir, resolved);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Session file not found: ${file}`);
    }
    return resolved;
  }

  if (!fs.existsSync(projectDir)) {
    throw new Error(`No session directory found for requested group`);
  }
  const candidates = fs
    .readdirSync(projectDir)
    .filter((file) => file.endsWith('.jsonl'))
    .map((file) => {
      const filePath = path.join(projectDir, file);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (!candidates.length) {
    throw new Error(`No session JSONL files found for requested group`);
  }
  return candidates[0].filePath;
}

function truncateText(text: string, max = 1600): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 15)}... [truncated]`;
}

function stringifySnippet(value: unknown): string | undefined {
  if (typeof value === 'string') return truncateText(value);
  if (value === undefined || value === null) return undefined;
  try {
    return truncateText(JSON.stringify(value));
  } catch {
    return truncateText(String(value));
  }
}

function extractContentSummary(content: unknown): {
  text?: string;
  toolNames?: string[];
} {
  if (typeof content === 'string') return { text: truncateText(content) };
  if (!Array.isArray(content)) return {};

  const textParts: string[] = [];
  const toolNames: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      textParts.push(record.text);
    } else if (record.type === 'tool_use' && typeof record.name === 'string') {
      toolNames.push(record.name);
    } else if (record.type === 'tool_result') {
      textParts.push('[tool_result]');
    }
  }

  return {
    text: textParts.length ? truncateText(textParts.join('\n')) : undefined,
    toolNames: toolNames.length ? toolNames : undefined,
  };
}

function summarizeSessionLine(line: string, lineNumber: number): unknown {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const message =
      parsed.message && typeof parsed.message === 'object'
        ? (parsed.message as Record<string, unknown>)
        : undefined;
    const contentSummary = extractContentSummary(message?.content);
    return {
      line: lineNumber,
      type: parsed.type,
      role: message?.role,
      timestamp: parsed.timestamp,
      uuid: parsed.uuid,
      sessionId: parsed.sessionId,
      text:
        contentSummary.text ??
        stringifySnippet(parsed.result) ??
        stringifySnippet(parsed.summary),
      toolNames: contentSummary.toolNames,
      subtype: parsed.subtype,
    };
  } catch (err) {
    return {
      line: lineNumber,
      type: 'parse_error',
      text: truncateText(line),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ------------------------------------------------------------------ */

const ACTION_REGISTRY: Record<string, ActionHandler> = {
  readGlobalMemory: async (params, ctx) => {
    assertMain(ctx);
    const globalDir = path.join(GROUPS_DIR, 'global');
    const filePath = resolveMemoryFile(globalDir, params?.file);
    const exists = fs.existsSync(filePath);
    return JSON.stringify({
      file: path.relative(globalDir, filePath),
      exists,
      content: exists ? fs.readFileSync(filePath, 'utf-8') : null,
    });
  },

  writeGlobalMemory: async (params, ctx) => {
    assertMain(ctx);
    const content = params?.content;
    if (typeof content !== 'string') {
      throw new Error('writeGlobalMemory: missing string params.content');
    }
    const globalDir = path.join(GROUPS_DIR, 'global');
    const filePath = resolveMemoryFile(globalDir, params?.file);
    const backupPath = backupFileIfPresent(filePath);
    writeFileAtomic(filePath, content);
    auditAdminMemory('writeGlobalMemory', ctx, {
      file: path.relative(globalDir, filePath),
      backupPath,
      bytes: Buffer.byteLength(content),
      sha256: contentHash(content),
    });
    return JSON.stringify({
      file: path.relative(globalDir, filePath),
      backupPath,
      bytes: Buffer.byteLength(content),
    });
  },

  readGroupMemory: async (params, ctx) => {
    assertMain(ctx);
    const groupFolder = parseGroupFolder(params?.group);
    const groupDir = resolveGroupFolderPath(groupFolder);
    const filePath = resolveMemoryFile(groupDir, params?.file);
    const exists = fs.existsSync(filePath);
    return JSON.stringify({
      group: groupFolder,
      file: path.relative(groupDir, filePath),
      exists,
      content: exists ? fs.readFileSync(filePath, 'utf-8') : null,
    });
  },

  writeGroupMemory: async (params, ctx) => {
    assertMain(ctx);
    const groupFolder = parseGroupFolder(params?.group);
    const content = params?.content;
    if (typeof content !== 'string') {
      throw new Error('writeGroupMemory: missing string params.content');
    }
    const groupDir = resolveGroupFolderPath(groupFolder);
    const filePath = resolveMemoryFile(groupDir, params?.file);
    const backupPath = backupFileIfPresent(filePath);
    writeFileAtomic(filePath, content);
    auditAdminMemory('writeGroupMemory', ctx, {
      group: groupFolder,
      file: path.relative(groupDir, filePath),
      backupPath,
      bytes: Buffer.byteLength(content),
      sha256: contentHash(content),
    });
    return JSON.stringify({
      group: groupFolder,
      file: path.relative(groupDir, filePath),
      backupPath,
      bytes: Buffer.byteLength(content),
    });
  },

  copyMemoryFileToGroup: async (params, ctx) => {
    assertMain(ctx);
    const groupFolder = parseGroupFolder(params?.group);
    const sourceFile = resolveMemoryFile(
      path.join(GROUPS_DIR, 'global'),
      params?.source,
    );
    if (!fs.existsSync(sourceFile)) {
      throw new Error(`Source memory file does not exist: ${params?.source}`);
    }
    const groupDir = resolveGroupFolderPath(groupFolder);
    const targetFile = resolveMemoryFile(
      groupDir,
      params?.target || path.basename(sourceFile),
    );
    const content = fs.readFileSync(sourceFile, 'utf-8');
    const backupPath = backupFileIfPresent(targetFile);
    writeFileAtomic(targetFile, content);
    auditAdminMemory('copyMemoryFileToGroup', ctx, {
      group: groupFolder,
      source: path.relative(path.join(GROUPS_DIR, 'global'), sourceFile),
      target: path.relative(groupDir, targetFile),
      backupPath,
      bytes: Buffer.byteLength(content),
      sha256: contentHash(content),
    });
    return JSON.stringify({
      group: groupFolder,
      source: path.relative(path.join(GROUPS_DIR, 'global'), sourceFile),
      target: path.relative(groupDir, targetFile),
      backupPath,
      bytes: Buffer.byteLength(content),
    });
  },

  inspectGroupConfig: async (params, ctx) => {
    assertMain(ctx);
    const groups = ctx.registeredGroups?.() || {};
    if (params?.group !== undefined) {
      const groupFolder = parseGroupFolder(params.group);
      const { jid, group } = findRegisteredGroupByFolder(ctx, groupFolder);
      return JSON.stringify({ jid, group });
    }
    return JSON.stringify(
      Object.entries(groups).map(([jid, group]) => ({ jid, group })),
    );
  },

  setGroupTriggerMode: async (params, ctx) => {
    assertMain(ctx);
    const groupFolder = parseGroupFolder(params?.group);
    if (typeof params?.requiresTrigger !== 'boolean') {
      throw new Error(
        'setGroupTriggerMode: missing boolean params.requiresTrigger',
      );
    }
    if (!ctx.updateRegisteredGroup) {
      throw new Error('setGroupTriggerMode: registration updater unavailable');
    }
    const { jid, group } = findRegisteredGroupByFolder(ctx, groupFolder);
    const updated = { ...group, requiresTrigger: params.requiresTrigger };
    ctx.updateRegisteredGroup(jid, updated);
    auditAdminMemory('setGroupTriggerMode', ctx, {
      group: groupFolder,
      jid,
      requiresTrigger: params.requiresTrigger,
    });
    return JSON.stringify({ jid, group: updated });
  },

  readGroupSessionTail: async (params, ctx) => {
    assertMain(ctx);
    const groupFolder = parseGroupFolder(params?.group);
    findRegisteredGroupByFolder(ctx, groupFolder);
    const limit = parsePositiveInt(params?.limit, 20, 100);
    const projectDir = resolveGroupSessionDir(groupFolder);
    const sessionPath = resolveSessionJsonlFile(
      projectDir,
      params?.sessionFile,
    );
    const raw = fs.readFileSync(sessionPath, 'utf-8');
    const lines = raw.trimEnd() ? raw.trimEnd().split('\n') : [];
    const start = Math.max(0, lines.length - limit);
    const entries = lines
      .slice(start)
      .map((line, index) => summarizeSessionLine(line, start + index + 1));

    return JSON.stringify(
      {
        group: groupFolder,
        file: path.basename(sessionPath),
        totalLines: lines.length,
        returnedLines: entries.length,
        entries,
      },
      null,
      2,
    );
  },

  listIntergroupInbox: async (params, ctx) => {
    assertMain(ctx);
    const limit = parsePositiveInt(params?.limit, 50, 200);
    return JSON.stringify(
      {
        items: listIntergroupInboxItems(ctx.sourceGroup, {
          includeAcknowledged: params?.includeAcknowledged === true,
          limit,
        }),
      },
      null,
      2,
    );
  },

  ackIntergroupInbox: async (params, ctx) => {
    assertMain(ctx);
    const id = parseInboxItemId(params?.id);
    return JSON.stringify(
      acknowledgeIntergroupInboxItem(ctx.sourceGroup, id, ctx.sourceGroup),
      null,
      2,
    );
  },

  surfaceToMain: async (params, ctx) => {
    if (!ctx) throw new Error('surfaceToMain: missing action context');
    const item = createIntergroupInboxItem({
      sourceGroup: ctx.sourceGroup,
      registeredGroups: ctx.registeredGroups?.() || {},
      surfaceId:
        typeof params?.surfaceId === 'string' ? params.surfaceId : undefined,
      subject: typeof params?.subject === 'string' ? params.subject : undefined,
      body: typeof params?.body === 'string' ? params.body : undefined,
      priority:
        typeof params?.priority === 'string' ? params.priority : undefined,
    });
    if (params?.notifyMainChat === true || item.priority === 'urgent') {
      queueIntergroupInboxNotification(item);
    }
    return JSON.stringify(item, null, 2);
  },

  /**
   * Bidirectional sync between ~/coding and ~/damrassbot/sync.
   * Inbound: git pull every repo (skipping _third_party).
   * Outbound: route files staged in sync/<repo>/<path> into the repo
   *   (WRITE / APPEND / SNAPSHOT depending on path + suffix), commit, push,
   *   delete the source. Optional params.filter (regex) scopes the run.
   */
  syncRepos: async (params) => runSyncRepos(params),

  /**
   * Convert text to speech via ElevenLabs TTS API.
   * Returns path to the generated audio file.
   * params.text: text to synthesize
   * params.voice_id: ElevenLabs voice ID or known voice name (lenient — names
   *   accepted here too so existing callers passing "vlad" as voice_id work)
   * params.voice: named voice from VOICES map (e.g. 'lucy', 'vlad')
   * params.model_id: optional model (defaults to eleven_turbo_v2_5)
   * Resolution: voice_id (as ID or name) > VOICES[voice] > ELEVENLABS_VOICE_ID env
   *
   * Output path: written to <groupIpcDir>/media/ when ctx is available, and
   * returned as the container-visible path /workspace/ipc/media/tts-<ts>.mp3.
   * Falls back to host /tmp only when no ctx (legacy / direct invocations).
   */
  ttsSpeak: async (params, ctx) => {
    const VOICES: Record<string, string> = {
      lucy: 'lcMyyd2HUfFzxdCaC4Ta',
      'funny-nigerian': 'ji8V21dyEPg5du75d9nX',
      indian: 'T8lgQl6x5PSdhmmWx42m',
      vlad: 'XjdmlV0OFXfXE6Mg2Sb7',
    };

    const envVars = readEnvFile(['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID']);
    const apiKey = process.env.ELEVENLABS_API_KEY || envVars.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');

    const { text, voice_id, voice, model_id } = params as {
      text: string;
      voice_id?: string;
      voice?: string;
      model_id?: string;
    };
    if (!text) throw new Error('ttsSpeak: missing params.text');

    if (voice && !VOICES[voice]) {
      throw new Error(
        `ttsSpeak: unknown voice name '${voice}'. Known: ${Object.keys(VOICES).join(', ')}`,
      );
    }

    // voice_id can be either a literal ElevenLabs UUID or one of the VOICES keys.
    const resolvedFromVoiceId = voice_id
      ? VOICES[voice_id] || voice_id
      : undefined;

    const voiceId =
      resolvedFromVoiceId ||
      (voice ? VOICES[voice] : undefined) ||
      process.env.ELEVENLABS_VOICE_ID ||
      envVars.ELEVENLABS_VOICE_ID;
    if (!voiceId)
      throw new Error(
        'ttsSpeak: no voice_id/voice provided and ELEVENLABS_VOICE_ID not set',
      );

    const res = await fetchWithTimeout(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      HOST_ACTION_FETCH_TIMEOUT_MS,
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
    const filename = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`;

    let hostPath: string;
    let returnedPath: string;
    if (ctx?.groupIpcDir) {
      const mediaDir = path.join(ctx.groupIpcDir, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });
      hostPath = path.join(mediaDir, filename);
      returnedPath = `/workspace/ipc/media/${filename}`;
    } else {
      hostPath = `/tmp/${filename}`;
      returnedPath = hostPath;
    }
    fs.writeFileSync(hostPath, buffer);
    logger.info(
      {
        chars: text.length,
        voiceId,
        hostPath,
        returnedPath,
        sourceGroup: ctx?.sourceGroup,
      },
      'TTS audio generated',
    );
    return JSON.stringify({ audioPath: returnedPath });
  },

  /**
   * Transcribe a retained audio artifact without exposing OPENAI_API_KEY to
   * the container. The requesting group can only access regular audio files
   * inside its own IPC media directory.
   */
  transcribeAudio: async (params, ctx) => {
    if (!ctx?.groupIpcDir) {
      throw new Error('transcribeAudio: missing action context');
    }
    if (typeof params?.audioPath !== 'string') {
      throw new Error('transcribeAudio: missing string params.audioPath');
    }

    const hostAudioPath = resolveTranscriptionAudioPath(
      params.audioPath,
      ctx.groupIpcDir,
    );
    const stat = fs.statSync(hostAudioPath);
    const maxBytes = 25 * 1024 * 1024;
    if (stat.size === 0) {
      throw new Error('transcribeAudio: audio file is empty');
    }
    if (stat.size > maxBytes) {
      throw new Error(
        `transcribeAudio: audio file exceeds ${maxBytes} byte limit`,
      );
    }

    const transcript = await transcribeAudio(
      fs.readFileSync(hostAudioPath),
      path.basename(hostAudioPath),
      RETAINED_TRANSCRIPTION_TIMEOUT_MS,
    );
    if (!transcript) {
      throw new Error(
        'transcribeAudio: transcription unavailable; retained audio was not deleted',
      );
    }

    updateTranscriptionMetadata(hostAudioPath, transcript.length);
    logger.info(
      {
        sourceGroup: ctx.sourceGroup,
        audioPath: params.audioPath,
        bytes: stat.size,
        transcriptChars: transcript.length,
      },
      'Retained audio transcribed via host action',
    );
    return JSON.stringify({
      audioPath: params.audioPath,
      transcript,
      chars: transcript.length,
    });
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

    const res = await fetchWithTimeout(
      url.toString(),
      HOST_ACTION_FETCH_TIMEOUT_MS,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${bearerToken}` },
      },
    );
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

    const res = await fetchWithTimeout(
      url.toString(),
      HOST_ACTION_FETCH_TIMEOUT_MS,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          'X-Places-Api-Version': '2025-06-17',
        },
      },
    );

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

  /**
   * Create a GitHub gist from a file the agent has staged in
   * /workspace/ipc/media/. Returns the gist URL as JSON: { url }.
   *
   * params.filePath: required container path under /workspace/ipc/media/
   * params.public: optional, defaults to false (gist is "secret"/unlisted)
   * params.description: optional gist description
   * params.filename: optional override for the file name in the gist
   *   (otherwise basename of filePath is used)
   */
  gistCreate: async (params, ctx) => {
    const {
      filePath,
      public: isPublic,
      description,
      filename,
    } = (params || {}) as {
      filePath?: string;
      public?: boolean;
      description?: string;
      filename?: string;
    };
    if (!filePath) throw new Error('gistCreate: missing params.filePath');
    if (!ctx?.groupIpcDir)
      throw new Error('gistCreate: missing ActionContext (groupIpcDir)');

    const hostPath = resolveContainerIpcPath(
      filePath,
      ctx.groupIpcDir,
      'gistCreate',
    );
    if (!fs.existsSync(hostPath))
      throw new Error(`gistCreate: file not found: ${filePath}`);

    // gh gist create [--public] [-d desc] [-f name] <file>
    // Default (no --public) is "secret"/unlisted.
    const args: string[] = ['gist', 'create'];
    if (isPublic) args.push('--public');
    if (description) args.push('-d', description);
    if (filename) args.push('-f', filename);
    args.push(hostPath);

    const { stdout } = await execFileAsync('gh', args);
    // gh prints the gist URL on the last non-empty line of stdout.
    const url = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    if (!url || !/^https:\/\/gist\.github\.com\//.test(url)) {
      throw new Error(
        `gistCreate: could not parse gist URL from output: ${stdout}`,
      );
    }
    logger.info(
      { url, public: !!isPublic, sourceGroup: ctx.sourceGroup },
      'gistCreate completed',
    );
    return JSON.stringify({ url });
  },

  /**
   * Call xAI's Responses API (Grok) with live search over X and/or the web.
   * Returns a synthesis text plus the raw response envelope.
   * Requires XAI_API_KEY env var (or .env entry).
   *
   * params.prompt: required user prompt
   * params.source: "x" | "web" | "x+web" (default "x+web")
   * params.model: defaults to "grok-4-1-fast"
   * params.systemPrompt: optional, prepended as a system role in input[]
   * params.fromDate / params.toDate: "YYYY-MM-DD"; prepended to the prompt
   *   as plain text since xAI live search has no native date-filter params.
   * params.maxOutputTokens: optional cap on response tokens
   * params.timeoutMs: default 120000 (xAI live search is slow)
   *
   * Returns JSON: { text, raw } — `text` is the concatenated output_text
   * across message items in response.output[] (may be empty string).
   */
  xAIFetch: async (params) => {
    const apiKey =
      process.env.XAI_API_KEY || readEnvFile(['XAI_API_KEY']).XAI_API_KEY;
    if (!apiKey) throw new Error('XAI_API_KEY not set');

    const {
      prompt,
      source,
      model,
      systemPrompt,
      fromDate,
      toDate,
      maxOutputTokens,
      timeoutMs,
    } = (params || {}) as {
      prompt?: string;
      source?: string;
      model?: string;
      systemPrompt?: string;
      fromDate?: string;
      toDate?: string;
      maxOutputTokens?: number;
      timeoutMs?: number;
    };

    if (!prompt) throw new Error('xAIFetch: missing params.prompt');

    const resolvedSource = source ?? 'x+web';
    if (
      resolvedSource !== 'x' &&
      resolvedSource !== 'web' &&
      resolvedSource !== 'x+web'
    ) {
      throw new Error(
        `xAIFetch: invalid source "${resolvedSource}". Must be "x", "web", or "x+web".`,
      );
    }

    const resolvedModel = model ?? 'grok-4-1-fast';
    const resolvedTimeout = timeoutMs ?? 120_000;

    const tools: Array<{ type: string }> = [];
    if (resolvedSource === 'x' || resolvedSource === 'x+web') {
      tools.push({ type: 'x_search' });
    }
    if (resolvedSource === 'web' || resolvedSource === 'x+web') {
      tools.push({ type: 'web_search' });
    }

    let datedPrompt = prompt;
    if (fromDate && toDate) {
      datedPrompt = `Search for results between ${fromDate} and ${toDate}. ${prompt}`;
    } else if (fromDate) {
      datedPrompt = `Search for results since ${fromDate}. ${prompt}`;
    } else if (toDate) {
      datedPrompt = `Search for results up to ${toDate}. ${prompt}`;
    }

    const input: Array<{ role: string; content: string }> = [];
    if (systemPrompt) input.push({ role: 'system', content: systemPrompt });
    input.push({ role: 'user', content: datedPrompt });

    const body: Record<string, unknown> = {
      model: resolvedModel,
      tools,
      input,
    };
    if (maxOutputTokens !== undefined) {
      body.max_output_tokens = maxOutputTokens;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), resolvedTimeout);

    let res: Response;
    try {
      res = await fetch('https://api.x.ai/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if ((err as { name?: string })?.name === 'AbortError') {
        throw new Error(`xAIFetch: timed out after ${resolvedTimeout}ms`);
      }
      throw err;
    }
    clearTimeout(timer);

    const respText = await res.text();
    if (!res.ok) {
      throw new Error(`xAI ${res.status}: ${respText}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(respText);
    } catch (err) {
      throw new Error(
        `xAIFetch: failed to parse response JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Walk output[] for items of type "message", concatenate output_text content.
    const texts: string[] = [];
    const output = (parsed as { output?: unknown }).output;
    if (Array.isArray(output)) {
      for (const item of output) {
        if (
          item &&
          typeof item === 'object' &&
          (item as { type?: string }).type === 'message'
        ) {
          const content = (item as { content?: unknown }).content;
          if (Array.isArray(content)) {
            for (const c of content) {
              if (
                c &&
                typeof c === 'object' &&
                (c as { type?: string }).type === 'output_text' &&
                typeof (c as { text?: unknown }).text === 'string'
              ) {
                texts.push((c as { text: string }).text);
              }
            }
          }
        }
      }
    }
    const text = texts.join('\n\n');

    logger.info(
      {
        promptChars: prompt.length,
        source: resolvedSource,
        model: resolvedModel,
        hasSystemPrompt: !!systemPrompt,
        fromDate,
        toDate,
        outputChars: text.length,
      },
      'xAIFetch completed',
    );

    return JSON.stringify({ text, raw: parsed });
  },

  /**
   * Append to or read from Milan's personal innernet log.
   * Requires INNERNET_ADMIN_TOKEN env var on the host.
   *
   * params.op: "read" | "log"
   * For "log":
   *   params.text: required entry text
   *   params.tags: optional comma-separated tags
   *   params.reflection: optional reflection
   *   params.visibility: "public" (default) | "private"
   * For "read":
   *   params.limit: max entries to return (default 50)
   */
  innernet: async (params) => {
    const token =
      process.env.INNERNET_ADMIN_TOKEN ||
      readEnvFile(['INNERNET_ADMIN_TOKEN']).INNERNET_ADMIN_TOKEN;
    if (!token) throw new Error('INNERNET_ADMIN_TOKEN not set');

    const BASE = 'https://api.innernet.znachilo.com';

    const { op, text, tags, reflection, visibility, limit } = (params ||
      {}) as {
      op?: string;
      text?: string;
      tags?: string;
      reflection?: string;
      visibility?: string;
      limit?: number;
    };

    if (!op) throw new Error('innernet: missing params.op');

    switch (op) {
      case 'read': {
        const res = await fetchWithTimeout(
          `${BASE}/logs`,
          HOST_ACTION_FETCH_TIMEOUT_MS,
          {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        const body = await res.text();
        if (!res.ok) throw new Error(`Innernet ${res.status}: ${body}`);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch (err) {
          throw new Error(
            `innernet read: failed to parse response JSON: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const effectiveLimit = limit ?? 50;
        const sliced = Array.isArray(parsed)
          ? parsed.slice(0, effectiveLimit)
          : parsed;
        logger.info({ op, limit: effectiveLimit }, 'innernet completed');
        return JSON.stringify(sliced);
      }

      case 'log': {
        if (typeof text !== 'string' || text.length === 0) {
          throw new Error('innernet log: missing or empty params.text');
        }
        if (
          visibility !== undefined &&
          visibility !== 'public' &&
          visibility !== 'private'
        ) {
          throw new Error(
            `innernet log: invalid visibility "${visibility}". Must be "public" or "private".`,
          );
        }
        const payload = {
          text,
          tags: tags ?? '',
          reflection: reflection ?? '',
          visibility: visibility ?? 'public',
          timestamp: new Date().toISOString(),
        };
        const res = await fetchWithTimeout(
          `${BASE}/log`,
          HOST_ACTION_FETCH_TIMEOUT_MS,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          },
        );
        const body = await res.text();
        if (!res.ok) throw new Error(`Innernet ${res.status}: ${body}`);
        let result: string;
        try {
          result = JSON.stringify(JSON.parse(body));
        } catch {
          result = JSON.stringify({ raw: body });
        }
        logger.info(
          {
            op,
            textChars: text.length,
            hasTags: !!tags,
            hasReflection: !!reflection,
            visibility: payload.visibility,
          },
          'innernet completed',
        );
        return result;
      }

      default:
        throw new Error(`innernet: unknown op "${op}". Valid: read, log`);
    }
  },

  /**
   * Search/read Milan's ChatGPT conversation archive on znachai.
   *
   * params.op: "search" | "read"
   * For "search":
   *   params.query: optional substring filter on title (case-insensitive)
   *   params.limit: max results (default 20)
   *   Returns chats sorted newest-first; empty query = recent slice.
   * For "read":
   *   params.id: chat id (8-char prefix or full uuid)
   *   Returns markdown body of the chat.
   */
  chats: async (params) => {
    const env = readEnvFile([
      'ZNACHAI_API_KEY',
      'ZNACHAI_READ_TOKEN',
      'ZNACHAI_URL',
    ]);
    const apiKey = process.env.ZNACHAI_API_KEY || env.ZNACHAI_API_KEY;
    const readToken = process.env.ZNACHAI_READ_TOKEN || env.ZNACHAI_READ_TOKEN;
    const BASE =
      process.env.ZNACHAI_URL || env.ZNACHAI_URL || 'https://znachai.fly.dev';

    const { op, query, limit, id } = (params || {}) as {
      op?: string;
      query?: string;
      limit?: number;
      id?: string;
    };

    if (!op) throw new Error('chats: missing params.op');

    const fetchIndex = async (): Promise<Array<Record<string, unknown>>> => {
      if (!apiKey) throw new Error('ZNACHAI_API_KEY not set');
      const res = await fetchWithTimeout(
        `${BASE}/api/chatgpt/chats`,
        HOST_ACTION_FETCH_TIMEOUT_MS,
        {
          headers: { 'X-API-Key': apiKey },
        },
      );
      const body = await res.text();
      if (!res.ok) throw new Error(`znachai ${res.status}: ${body}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        throw new Error(
          `chats: failed to parse index JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const arr = (parsed as { chats?: unknown })?.chats;
      return Array.isArray(arr) ? (arr as Array<Record<string, unknown>>) : [];
    };

    switch (op) {
      case 'search': {
        let chats = await fetchIndex();
        if (query && typeof query === 'string' && query.length > 0) {
          const q = query.toLowerCase();
          chats = chats.filter((c) =>
            String(c.title ?? '')
              .toLowerCase()
              .includes(q),
          );
        }
        const effectiveLimit = limit ?? 20;
        const sliced = chats.slice(0, effectiveLimit).map((c) => ({
          id: c.id,
          title: c.title,
          msg_count: c.msg_count ?? c.messageCount,
          update_time: c.update_time ?? c.updated_at,
        }));
        logger.info(
          {
            op,
            hasQuery: !!query,
            limit: effectiveLimit,
            returned: sliced.length,
          },
          'chats completed',
        );
        return JSON.stringify(sliced);
      }

      case 'read': {
        if (!readToken) throw new Error('ZNACHAI_READ_TOKEN not set');
        if (!id || typeof id !== 'string') {
          throw new Error('chats read: missing params.id');
        }
        let fullId = id;
        if (id.length < 36) {
          const chats = await fetchIndex();
          const matches = chats.filter((c) =>
            String(c.id ?? '').startsWith(id),
          );
          if (matches.length === 0) {
            throw new Error(`chats read: no chat matching id "${id}"`);
          }
          if (matches.length > 1) {
            throw new Error(
              `chats read: ambiguous id "${id}" matches ${matches.length} chats`,
            );
          }
          fullId = String(matches[0].id);
        }
        const url = `${BASE}/chats/${fullId}.md?token=${encodeURIComponent(readToken)}`;
        const res = await fetchWithTimeout(url, HOST_ACTION_FETCH_TIMEOUT_MS);
        const body = await res.text();
        if (!res.ok) throw new Error(`znachai ${res.status}: ${body}`);
        logger.info({ op, id: fullId, bytes: body.length }, 'chats completed');
        return body;
      }

      default:
        throw new Error(`chats: unknown op "${op}". Valid: search, read`);
    }
  },
};

/**
 * Translate a /workspace/ipc/... container path to its host equivalent
 * under the given group's IPC dir, with bounds-check.
 */
function resolveContainerIpcPath(
  containerPath: string,
  groupIpcDir: string,
  kind: string,
): string {
  const CONTAINER_IPC_PREFIX = '/workspace/ipc/';
  if (!containerPath.startsWith(CONTAINER_IPC_PREFIX)) {
    throw new Error(
      `${kind}: path must be under /workspace/ipc/: ${containerPath}`,
    );
  }
  const rel = containerPath.slice(CONTAINER_IPC_PREFIX.length);
  const candidate = path.resolve(groupIpcDir, rel);
  if (
    candidate !== groupIpcDir &&
    !candidate.startsWith(groupIpcDir + path.sep)
  ) {
    throw new Error(`${kind}: path escapes group IPC dir: ${containerPath}`);
  }
  return candidate;
}

const TRANSCRIPTION_AUDIO_EXTENSIONS = new Set([
  '.flac',
  '.m4a',
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpga',
  '.oga',
  '.ogg',
  '.wav',
  '.webm',
]);

function resolveTranscriptionAudioPath(
  containerPath: string,
  groupIpcDir: string,
): string {
  const mediaDir = path.resolve(groupIpcDir, 'media');
  const candidate = resolveContainerIpcPath(
    containerPath,
    groupIpcDir,
    'transcribeAudio',
  );
  ensureWithinBase(mediaDir, candidate);

  const extension = path.extname(candidate).toLowerCase();
  if (!TRANSCRIPTION_AUDIO_EXTENSIONS.has(extension)) {
    throw new Error(
      `transcribeAudio: unsupported audio extension "${extension || '(none)'}"`,
    );
  }

  const linkStat = fs.lstatSync(candidate);
  if (!linkStat.isFile() || linkStat.isSymbolicLink()) {
    throw new Error('transcribeAudio: path must be a regular audio file');
  }
  const realMediaDir = fs.realpathSync(mediaDir);
  const realPath = fs.realpathSync(candidate);
  ensureWithinBase(realMediaDir, realPath);
  return realPath;
}

function updateTranscriptionMetadata(
  hostAudioPath: string,
  transcriptChars: number,
): void {
  const metadataPath = hostAudioPath.replace(/\.[^.]+$/, '.json');
  if (!fs.existsSync(metadataPath)) return;

  try {
    const metadata = JSON.parse(
      fs.readFileSync(metadataPath, 'utf-8'),
    ) as Record<string, unknown>;
    writeFileAtomic(
      metadataPath,
      JSON.stringify(
        {
          ...metadata,
          status: 'transcribed_by_host_action',
          transcript_chars: transcriptChars,
          transcribed_at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    logger.warn(
      { err, metadataPath },
      'Failed to update retained audio transcription metadata',
    );
  }
}

export async function dispatchAction(
  request: ActionRequest,
  ctx?: ActionContext,
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
    const output = await handler(request.params, ctx);
    return { requestId: request.requestId, ok: true, output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { requestId: request.requestId, ok: false, output: msg };
  }
}
