import { execFile } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { GOOGLE_POLICY_PATH, HOME_DIR } from './config.js';
import {
  claimGoogleApproval,
  createGoogleApproval,
  decideGoogleApproval,
  expirePendingGoogleApprovals,
  findActiveGoogleApproval,
  finishGoogleApproval,
  getGoogleApproval,
  listGoogleApprovalsByState,
  type GoogleApproval,
} from './db.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);
const GOOGLE_EXEC_TIMEOUT_MS = 60_000;
const MAX_DOC_CONTENT_BYTES = 500_000;
const MAX_RESULT_BYTES = 2_000_000;
const APPROVAL_ID_PATTERN = /^G-[A-F0-9]{10}$/;
const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{10,}$/;
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{10,}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{3,}$/;

export type GoogleWriteMode = 'deny' | 'manual' | 'auto';
type GoogleWriteOperation = 'calendar.create' | 'calendar.update';

interface GoogleAccountPolicy {
  email: string;
  groups: string[];
}

interface GoogleCalendarPolicy {
  account: string;
  calendarId: string;
  groups?: string[];
  shared?: boolean;
  read?: boolean;
  create?: GoogleWriteMode;
  update?: GoogleWriteMode;
}

interface GoogleDocsPolicy {
  account: string;
  groups?: string[];
  read?: boolean;
}

interface GoogleDrivePolicy {
  account: string;
  groups?: string[];
  search?: boolean;
  list?: boolean;
}

interface GoogleGmailPolicy {
  account: string;
  groups?: string[];
  search?: boolean;
  read?: boolean;
}

export interface GooglePolicy {
  version: 1;
  gogPath?: string;
  approvals: {
    telegramChatJid: string;
    telegramUserIds: string[];
    ttlSeconds?: number;
  };
  accounts: Record<string, GoogleAccountPolicy>;
  calendars?: Record<string, GoogleCalendarPolicy>;
  docs?: Record<string, GoogleDocsPolicy>;
  drive?: Record<string, GoogleDrivePolicy>;
  gmail?: Record<string, GoogleGmailPolicy>;
}

export interface GoogleActionContext {
  sourceGroup: string;
  sourceChatJid: string;
  groupIpcDir: string;
  sendMessage: (
    jid: string,
    text: string,
    approvalId?: string,
  ) => Promise<void>;
}

interface GoogleCommandOutcome {
  reply: string;
}

interface StoredWritePayload {
  operation: GoogleWriteOperation;
  accountAlias: string;
  resourceAlias: string;
  values: Record<string, unknown>;
}

class GoogleMutationUncertainError extends Error {}

let cachedPolicy: { mtimeMs: number; policy: GooglePolicy } | null = null;
const inFlightExecutions = new Set<Promise<unknown>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertAlias(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)
  ) {
    throw new Error(`${label} must be a configured alias`);
  }
}

function assertString(
  value: unknown,
  label: string,
  maxLength = 20_000,
): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function optionalString(
  value: unknown,
  label: string,
  maxLength = 20_000,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  assertString(value, label, maxLength);
  return value;
}

function assertExactKeys(
  params: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(params).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unsupported Google action fields: ${unknown.join(', ')}`);
  }
}

function validatePolicy(value: unknown): GooglePolicy {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error('Google policy must be an object with version 1');
  }
  if (
    value.gogPath !== undefined &&
    (typeof value.gogPath !== 'string' || !path.isAbsolute(value.gogPath))
  ) {
    throw new Error('Google policy gogPath must be absolute');
  }
  if (!isRecord(value.approvals)) {
    throw new Error('Google policy approvals are required');
  }
  if (
    typeof value.approvals.telegramChatJid !== 'string' ||
    !/^tg:\d+$/.test(value.approvals.telegramChatJid)
  ) {
    throw new Error(
      'approvals.telegramChatJid must be a private Telegram chat JID',
    );
  }
  if (
    !Array.isArray(value.approvals.telegramUserIds) ||
    value.approvals.telegramUserIds.length === 0 ||
    value.approvals.telegramUserIds.some(
      (id) => typeof id !== 'string' || !/^\d+$/.test(id),
    )
  ) {
    throw new Error(
      'approvals.telegramUserIds must contain explicit Telegram user IDs',
    );
  }
  if (
    value.approvals.ttlSeconds !== undefined &&
    (typeof value.approvals.ttlSeconds !== 'number' ||
      !Number.isFinite(value.approvals.ttlSeconds))
  ) {
    throw new Error('approvals.ttlSeconds must be a number');
  }
  if (!isRecord(value.accounts) || Object.keys(value.accounts).length === 0) {
    throw new Error('Google policy accounts are required');
  }
  for (const [alias, account] of Object.entries(value.accounts)) {
    assertAlias(alias, 'account alias');
    if (
      !isRecord(account) ||
      typeof account.email !== 'string' ||
      !account.email.includes('@') ||
      !Array.isArray(account.groups) ||
      account.groups.length === 0 ||
      account.groups.some((group) => typeof group !== 'string')
    ) {
      throw new Error(`Invalid Google account policy "${alias}"`);
    }
  }
  if (value.calendars !== undefined) {
    if (!isRecord(value.calendars)) {
      throw new Error('calendars must be an object');
    }
    for (const [alias, calendar] of Object.entries(value.calendars)) {
      assertAlias(alias, 'calendar alias');
      if (
        !isRecord(calendar) ||
        typeof calendar.account !== 'string' ||
        !value.accounts[calendar.account] ||
        typeof calendar.calendarId !== 'string' ||
        !calendar.calendarId.trim()
      ) {
        throw new Error(`Invalid calendar resource "${alias}"`);
      }
      if (
        calendar.groups !== undefined &&
        (!Array.isArray(calendar.groups) ||
          calendar.groups.some((group) => typeof group !== 'string'))
      ) {
        throw new Error(`Invalid calendar groups for "${alias}"`);
      }
      if (calendar.read !== undefined && typeof calendar.read !== 'boolean') {
        throw new Error(`Invalid calendar read mode for "${alias}"`);
      }
      for (const key of ['create', 'update']) {
        const mode = calendar[key];
        if (
          mode !== undefined &&
          mode !== 'deny' &&
          mode !== 'manual' &&
          mode !== 'auto'
        ) {
          throw new Error(`Invalid calendar.${alias}.${key} mode`);
        }
      }
    }
  }
  if (value.docs !== undefined) {
    if (!isRecord(value.docs)) throw new Error('docs must be an object');
    for (const [alias, docs] of Object.entries(value.docs)) {
      assertAlias(alias, 'Docs alias');
      if (
        !isRecord(docs) ||
        typeof docs.account !== 'string' ||
        !value.accounts[docs.account]
      ) {
        throw new Error(`Invalid Docs resource "${alias}"`);
      }
      if (
        docs.groups !== undefined &&
        (!Array.isArray(docs.groups) ||
          docs.groups.some((group) => typeof group !== 'string'))
      ) {
        throw new Error(`Invalid Docs groups for "${alias}"`);
      }
      if (docs.read !== undefined && typeof docs.read !== 'boolean') {
        throw new Error(`Invalid Docs read mode for "${alias}"`);
      }
    }
  }
  if (value.drive !== undefined) {
    if (!isRecord(value.drive)) throw new Error('drive must be an object');
    for (const [alias, drive] of Object.entries(value.drive)) {
      assertAlias(alias, 'Drive alias');
      if (
        !isRecord(drive) ||
        typeof drive.account !== 'string' ||
        !value.accounts[drive.account]
      ) {
        throw new Error(`Invalid Drive resource "${alias}"`);
      }
      if (
        drive.groups !== undefined &&
        (!Array.isArray(drive.groups) ||
          drive.groups.some((group) => typeof group !== 'string'))
      ) {
        throw new Error(`Invalid Drive groups for "${alias}"`);
      }
      for (const key of ['search', 'list']) {
        if (drive[key] !== undefined && typeof drive[key] !== 'boolean') {
          throw new Error(`Invalid Drive ${key} mode for "${alias}"`);
        }
      }
    }
  }
  if (value.gmail !== undefined) {
    if (!isRecord(value.gmail)) throw new Error('gmail must be an object');
    for (const [alias, gmail] of Object.entries(value.gmail)) {
      assertAlias(alias, 'Gmail alias');
      if (
        !isRecord(gmail) ||
        typeof gmail.account !== 'string' ||
        !value.accounts[gmail.account]
      ) {
        throw new Error(`Invalid Gmail resource "${alias}"`);
      }
      if (
        gmail.groups !== undefined &&
        (!Array.isArray(gmail.groups) ||
          gmail.groups.some((group) => typeof group !== 'string'))
      ) {
        throw new Error(`Invalid Gmail groups for "${alias}"`);
      }
      for (const key of ['search', 'read']) {
        if (gmail[key] !== undefined && typeof gmail[key] !== 'boolean') {
          throw new Error(`Invalid Gmail ${key} mode for "${alias}"`);
        }
      }
    }
  }
  return value as unknown as GooglePolicy;
}

export function loadGooglePolicy(): GooglePolicy {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(GOOGLE_POLICY_PATH);
  } catch {
    throw new Error(
      `Google integration is disabled: policy not found at ${GOOGLE_POLICY_PATH}`,
    );
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(
      `Google policy must not be group- or world-writable: ${GOOGLE_POLICY_PATH}`,
    );
  }
  if (cachedPolicy?.mtimeMs === stat.mtimeMs) return cachedPolicy.policy;
  const policy = validatePolicy(
    JSON.parse(fs.readFileSync(GOOGLE_POLICY_PATH, 'utf8')),
  );
  cachedPolicy = { mtimeMs: stat.mtimeMs, policy };
  return policy;
}

function accountFor(
  policy: GooglePolicy,
  alias: string,
  sourceGroup: string,
): GoogleAccountPolicy {
  const account = policy.accounts[alias];
  if (!account) throw new Error(`Unknown Google account alias "${alias}"`);
  if (!account.groups.includes(sourceGroup)) {
    throw new Error(
      `Group "${sourceGroup}" cannot use Google account "${alias}"`,
    );
  }
  return account;
}

function assertResourceGroup(
  groups: string[] | undefined,
  sourceGroup: string,
  alias: string,
): void {
  if (groups && !groups.includes(sourceGroup)) {
    throw new Error(
      `Group "${sourceGroup}" cannot use Google resource "${alias}"`,
    );
  }
}

function calendarResource(
  policy: GooglePolicy,
  alias: string,
  sourceGroup: string,
): { resource: GoogleCalendarPolicy; account: GoogleAccountPolicy } {
  const resource = policy.calendars?.[alias];
  if (!resource) throw new Error(`Unknown calendar alias "${alias}"`);
  assertResourceGroup(resource.groups, sourceGroup, alias);
  return {
    resource,
    account: accountFor(policy, resource.account, sourceGroup),
  };
}

function docsResource(
  policy: GooglePolicy,
  alias: string,
  sourceGroup: string,
): { resource: GoogleDocsPolicy; account: GoogleAccountPolicy } {
  const resource = policy.docs?.[alias];
  if (!resource) throw new Error(`Unknown Docs alias "${alias}"`);
  assertResourceGroup(resource.groups, sourceGroup, alias);
  return {
    resource,
    account: accountFor(policy, resource.account, sourceGroup),
  };
}

function driveResource(
  policy: GooglePolicy,
  alias: string,
  sourceGroup: string,
): { resource: GoogleDrivePolicy; account: GoogleAccountPolicy } {
  const resource = policy.drive?.[alias];
  if (!resource) throw new Error(`Unknown Drive alias "${alias}"`);
  assertResourceGroup(resource.groups, sourceGroup, alias);
  return {
    resource,
    account: accountFor(policy, resource.account, sourceGroup),
  };
}

function gmailResource(
  policy: GooglePolicy,
  alias: string,
  sourceGroup: string,
): { resource: GoogleGmailPolicy; account: GoogleAccountPolicy } {
  const resource = policy.gmail?.[alias];
  if (!resource) throw new Error(`Unknown Gmail alias "${alias}"`);
  assertResourceGroup(resource.groups, sourceGroup, alias);
  return {
    resource,
    account: accountFor(policy, resource.account, sourceGroup),
  };
}

function commonGogArgs(
  accountEmail: string,
  exactCommand: string,
  readonly: boolean,
): string[] {
  return [
    '--account',
    accountEmail,
    '--no-input',
    '--json',
    '--results-only',
    '--gmail-no-send',
    '--enable-commands-exact',
    exactCommand,
    ...(readonly ? ['--readonly', '--wrap-untrusted'] : []),
  ];
}

function gogEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const passwordFile = path.join(
    HOME_DIR,
    '.config',
    'gogcli',
    'keyring_password',
  );
  if (!env.GOG_KEYRING_PASSWORD && fs.existsSync(passwordFile)) {
    const stat = fs.statSync(passwordFile);
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(
        `gog keyring password file must have mode 0600: ${passwordFile}`,
      );
    }
    env.GOG_KEYRING_BACKEND = env.GOG_KEYRING_BACKEND || 'file';
    env.GOG_KEYRING_PASSWORD = fs.readFileSync(passwordFile, 'utf8').trim();
  }
  return env;
}

async function runGog(policy: GooglePolicy, args: string[]): Promise<string> {
  const gogPath = policy.gogPath || path.join(HOME_DIR, '.local', 'bin', 'gog');
  const diagnosticId = `GW-${randomBytes(5).toString('hex').toUpperCase()}`;
  const exactCommandIndex = args.indexOf('--enable-commands-exact');
  const command =
    exactCommandIndex >= 0 && args[exactCommandIndex + 1]
      ? args[exactCommandIndex + 1]
      : args.slice(0, 2).join('.');
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(gogPath, args, {
      timeout: GOOGLE_EXEC_TIMEOUT_MS,
      maxBuffer: MAX_RESULT_BYTES,
      env: gogEnvironment(),
    });
    const durationMs = Date.now() - startedAt;
    if (stderr.trim()) {
      logger.debug(
        {
          diagnosticId,
          command,
          durationMs,
          stderr: stderr.trim().slice(0, 1000),
        },
        'gog command stderr',
      );
    }
    logger.info(
      {
        diagnosticId,
        command,
        durationMs,
        outputBytes: Buffer.byteLength(stdout),
      },
      'gog command completed',
    );
    return stdout.trim();
  } catch (err) {
    const detail = err as {
      code?: string | number;
      killed?: boolean;
      signal?: string;
      stderr?: string;
    };
    const durationMs = Date.now() - startedAt;
    const stderr =
      typeof detail.stderr === 'string'
        ? detail.stderr.trim().slice(0, 1000)
        : '';
    logger.error(
      {
        diagnosticId,
        command,
        durationMs,
        exitCode: detail.code,
        killed: detail.killed,
        signal: detail.signal,
        stderr,
      },
      'gog command failed',
    );
    const classification =
      detail.killed || durationMs >= GOOGLE_EXEC_TIMEOUT_MS
        ? 'timeout'
        : detail.code === 'ENOENT'
          ? 'binary_not_found'
          : 'command_failed';
    throw new Error(
      `Google host command failed (${classification}; diagnostic ${diagnosticId}; command ${command}${detail.code !== undefined ? `; exit ${detail.code}` : ''}${stderr ? `; stderr ${stderr}` : ''})`,
    );
  }
}

export async function googleCalendarList(
  params: Record<string, unknown>,
  sourceGroup: string,
): Promise<string> {
  assertExactKeys(params, ['calendar', 'from', 'to', 'query', 'max']);
  const alias = params.calendar;
  assertAlias(alias, 'calendar');
  const from = optionalString(params.from, 'from', 100);
  const to = optionalString(params.to, 'to', 100);
  const query = optionalString(params.query, 'query', 500);
  const max =
    typeof params.max === 'number' && Number.isInteger(params.max)
      ? Math.min(Math.max(params.max, 1), 100)
      : 25;
  const policy = loadGooglePolicy();
  const { resource, account } = calendarResource(policy, alias, sourceGroup);
  if (resource.read !== true) {
    throw new Error(`Calendar "${alias}" is not readable`);
  }
  return runGog(policy, [
    'calendar',
    'events',
    resource.calendarId,
    ...(from ? ['--from', from] : []),
    ...(to ? ['--to', to] : []),
    ...(query ? ['--query', query] : []),
    '--max',
    String(max),
    ...commonGogArgs(account.email, 'calendar.events', true),
  ]);
}

export async function googleDocsRead(
  params: Record<string, unknown>,
  sourceGroup: string,
): Promise<string> {
  assertExactKeys(params, ['docs', 'docId']);
  const alias = params.docs;
  const docId = params.docId;
  assertAlias(alias, 'docs');
  assertString(docId, 'docId', 200);
  if (!DOC_ID_PATTERN.test(docId)) throw new Error('Invalid Google Doc ID');
  const policy = loadGooglePolicy();
  const { resource, account } = docsResource(policy, alias, sourceGroup);
  if (resource.read !== true) {
    throw new Error(`Docs "${alias}" is not readable`);
  }
  return runGog(policy, [
    'docs',
    'cat',
    docId,
    '--max-bytes',
    String(MAX_DOC_CONTENT_BYTES),
    ...commonGogArgs(account.email, 'docs.cat', true),
  ]);
}

function boundedDriveMax(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(Math.max(value, 1), 100)
    : fallback;
}

export async function googleDriveSearch(
  params: Record<string, unknown>,
  sourceGroup: string,
): Promise<string> {
  assertExactKeys(params, ['drive', 'query', 'max']);
  const alias = params.drive;
  const query = params.query;
  assertAlias(alias, 'drive');
  assertString(query, 'query', 1000);
  if (query.trim().startsWith('--')) {
    throw new Error('Drive query must not start with a command flag');
  }
  const policy = loadGooglePolicy();
  const { resource, account } = driveResource(policy, alias, sourceGroup);
  if (resource.search !== true) {
    throw new Error(`Drive "${alias}" is not searchable`);
  }
  return runGog(policy, [
    'drive',
    'search',
    query,
    '--max',
    String(boundedDriveMax(params.max, 25)),
    ...commonGogArgs(account.email, 'drive.search', true),
  ]);
}

export async function googleDriveListFolder(
  params: Record<string, unknown>,
  sourceGroup: string,
): Promise<string> {
  assertExactKeys(params, ['drive', 'folderId', 'max']);
  const alias = params.drive;
  const folderId = params.folderId;
  assertAlias(alias, 'drive');
  assertString(folderId, 'folderId', 200);
  if (!DRIVE_ID_PATTERN.test(folderId)) {
    throw new Error('Invalid Google Drive folder ID');
  }
  const policy = loadGooglePolicy();
  const { resource, account } = driveResource(policy, alias, sourceGroup);
  if (resource.list !== true) {
    throw new Error(`Drive "${alias}" folders are not browseable`);
  }
  return runGog(policy, [
    'drive',
    'ls',
    '--parent',
    folderId,
    '--max',
    String(boundedDriveMax(params.max, 50)),
    ...commonGogArgs(account.email, 'drive.ls', true),
  ]);
}

function boundedGmailMax(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(Math.max(value, 1), 50)
    : fallback;
}

function assertGmailId(value: unknown, label: string): asserts value is string {
  assertString(value, label, 200);
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(value)) {
    throw new Error(`Invalid Gmail ${label}`);
  }
}

function decodeLinkEntities(value: string): string {
  const decodeCodePoint = (
    original: string,
    encoded: string,
    radix: number,
  ): string => {
    const codePoint = parseInt(encoded, radix);
    return Number.isInteger(codePoint) &&
      codePoint >= 0 &&
      codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : original;
  };
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (original: string, hex: string) =>
      decodeCodePoint(original, hex, 16),
    )
    .replace(/&#(\d+);/g, (original: string, decimal: string) =>
      decodeCodePoint(original, decimal, 10),
    )
    .replace(/=3D/gi, '=');
}

interface GoogleWorkspaceLink {
  kind:
    | 'document'
    | 'spreadsheet'
    | 'presentation'
    | 'form'
    | 'folder'
    | 'file';
  id: string;
  url: string;
}

function canonicalGoogleWorkspaceLink(
  candidate: string,
): GoogleWorkspaceLink | undefined {
  let parsed: URL;
  try {
    parsed = new URL(decodeLinkEntities(candidate));
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:') return undefined;

  const host = parsed.hostname.toLowerCase();
  const pathParts = parsed.pathname.split('/').filter(Boolean);
  let kind: GoogleWorkspaceLink['kind'];
  let id: string | null | undefined;
  let url: string;

  if (host === 'docs.google.com') {
    const type = pathParts[0];
    const dIndex = pathParts.indexOf('d');
    const usesPublishedFormId =
      type === 'forms' && dIndex >= 0 && pathParts[dIndex + 1] === 'e';
    id =
      dIndex >= 0
        ? pathParts[dIndex + (usesPublishedFormId ? 2 : 1)]
        : undefined;
    const kindByType: Record<string, GoogleWorkspaceLink['kind']> = {
      document: 'document',
      spreadsheets: 'spreadsheet',
      presentation: 'presentation',
      forms: 'form',
    };
    kind = kindByType[type];
    if (!kind || !id || !DRIVE_ID_PATTERN.test(id)) return undefined;
    url = `https://docs.google.com/${type}/d/${usesPublishedFormId ? 'e/' : ''}${id}`;
  } else if (host === 'drive.google.com') {
    const foldersIndex = pathParts.indexOf('folders');
    const fileIndex = pathParts.indexOf('file');
    if (foldersIndex >= 0) {
      kind = 'folder';
      id = pathParts[foldersIndex + 1];
      if (!id || !DRIVE_ID_PATTERN.test(id)) return undefined;
      url = `https://drive.google.com/drive/folders/${id}`;
    } else if (fileIndex >= 0 && pathParts[fileIndex + 1] === 'd') {
      kind = 'file';
      id = pathParts[fileIndex + 2];
      if (!id || !DRIVE_ID_PATTERN.test(id)) return undefined;
      url = `https://drive.google.com/file/d/${id}`;
    } else {
      kind = 'file';
      id = parsed.searchParams.get('id');
      if (!id || !DRIVE_ID_PATTERN.test(id)) return undefined;
      url = `https://drive.google.com/open?id=${id}`;
    }
  } else {
    return undefined;
  }

  return { kind, id, url };
}

export function extractGoogleWorkspaceLinks(output: string): string {
  const candidates = new Set<string>();
  const collect = (value: unknown, depth: number): void => {
    if (depth > 12) return;
    if (typeof value === 'string') {
      for (const match of decodeLinkEntities(value).matchAll(
        /https?:\/\/[^\s<>"'\\]+/gi,
      )) {
        candidates.add(match[0].replace(/[),.;]+$/, ''));
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) collect(child, depth + 1);
      return;
    }
    if (isRecord(value)) {
      for (const child of Object.values(value)) collect(child, depth + 1);
    }
  };

  collect(parsedJson(output), 0);
  const links = [...candidates]
    .map(canonicalGoogleWorkspaceLink)
    .filter((link): link is GoogleWorkspaceLink => Boolean(link));
  const unique = [
    ...new Map(links.map((link) => [`${link.kind}:${link.id}`, link])).values(),
  ];
  return JSON.stringify({ links: unique });
}

async function runGmailSearch(
  alias: string,
  query: string,
  max: number,
  sourceGroup: string,
): Promise<string> {
  if (query.trim().startsWith('--')) {
    throw new Error('Gmail query must not start with a command flag');
  }
  const policy = loadGooglePolicy();
  const { resource, account } = gmailResource(policy, alias, sourceGroup);
  if (resource.search !== true) {
    throw new Error(`Gmail "${alias}" is not searchable`);
  }
  return runGog(policy, [
    'gmail',
    'messages',
    'search',
    query,
    '--max',
    String(max),
    ...commonGogArgs(account.email, 'gmail.messages.search', true),
  ]);
}

export async function googleGmailSearch(
  params: Record<string, unknown>,
  sourceGroup: string,
): Promise<string> {
  assertExactKeys(params, ['gmail', 'query', 'max']);
  const alias = params.gmail;
  const query = params.query;
  assertAlias(alias, 'gmail');
  assertString(query, 'query', 1000);
  return runGmailSearch(
    alias,
    query,
    boundedGmailMax(params.max, 20),
    sourceGroup,
  );
}

export async function googleGmailRecentDrafts(
  params: Record<string, unknown>,
  sourceGroup: string,
): Promise<string> {
  assertExactKeys(params, ['gmail', 'max']);
  const alias = params.gmail;
  assertAlias(alias, 'gmail');
  return runGmailSearch(
    alias,
    'in:drafts',
    boundedGmailMax(params.max, 10),
    sourceGroup,
  );
}

export async function googleGmailMessageRead(
  params: Record<string, unknown>,
  sourceGroup: string,
): Promise<string> {
  assertExactKeys(params, ['gmail', 'messageId']);
  const alias = params.gmail;
  const messageId = params.messageId;
  assertAlias(alias, 'gmail');
  assertGmailId(messageId, 'messageId');
  const policy = loadGooglePolicy();
  const { resource, account } = gmailResource(policy, alias, sourceGroup);
  if (resource.read !== true) {
    throw new Error(`Gmail "${alias}" messages are not readable`);
  }
  return runGog(policy, [
    'gmail',
    'get',
    messageId,
    '--format',
    'full',
    '--sanitize-content',
    ...commonGogArgs(account.email, 'gmail.get', true),
  ]);
}

export async function googleGmailThreadRead(
  params: Record<string, unknown>,
  sourceGroup: string,
): Promise<string> {
  assertExactKeys(params, ['gmail', 'threadId']);
  const alias = params.gmail;
  const threadId = params.threadId;
  assertAlias(alias, 'gmail');
  assertGmailId(threadId, 'threadId');
  const policy = loadGooglePolicy();
  const { resource, account } = gmailResource(policy, alias, sourceGroup);
  if (resource.read !== true) {
    throw new Error(`Gmail "${alias}" threads are not readable`);
  }
  return runGog(policy, [
    'gmail',
    'thread',
    'get',
    threadId,
    '--full',
    '--sanitize-content',
    ...commonGogArgs(account.email, 'gmail.thread.get', true),
  ]);
}

export async function googleGmailWorkspaceLinks(
  params: Record<string, unknown>,
  sourceGroup: string,
): Promise<string> {
  assertExactKeys(params, ['gmail', 'threadId']);
  const alias = params.gmail;
  const threadId = params.threadId;
  assertAlias(alias, 'gmail');
  assertGmailId(threadId, 'threadId');
  const policy = loadGooglePolicy();
  const { resource, account } = gmailResource(policy, alias, sourceGroup);
  if (resource.read !== true) {
    throw new Error(`Gmail "${alias}" threads are not readable`);
  }
  const output = await runGog(policy, [
    'gmail',
    'thread',
    'get',
    threadId,
    '--full',
    ...commonGogArgs(account.email, 'gmail.thread.get', true),
  ]);
  return extractGoogleWorkspaceLinks(output);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function textHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parsedJson(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

function extractString(
  output: string,
  keys: readonly string[],
): string | undefined {
  const visit = (value: unknown, depth: number): string | undefined => {
    if (depth > 5 || !isRecord(value)) return undefined;
    for (const key of keys) {
      if (typeof value[key] === 'string') return value[key];
    }
    for (const child of Object.values(value)) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return visit(parsedJson(output), 0);
}

function eventHasAttendees(output: string): boolean {
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 5) return false;
    if (Array.isArray(value)) {
      return value.some((child) => visit(child, depth + 1));
    }
    if (!isRecord(value)) return false;
    if (Array.isArray(value.attendees) && value.attendees.length > 0) {
      return true;
    }
    return Object.values(value).some((child) => visit(child, depth + 1));
  };
  return visit(parsedJson(output), 0);
}

async function readCalendarEvent(
  policy: GooglePolicy,
  resource: GoogleCalendarPolicy,
  account: GoogleAccountPolicy,
  eventId: string,
): Promise<string> {
  return runGog(policy, [
    'calendar',
    'event',
    resource.calendarId,
    eventId,
    ...commonGogArgs(account.email, 'calendar.event', true),
  ]);
}

function writeMode(
  resource: GoogleCalendarPolicy,
  operation: GoogleWriteOperation,
): GoogleWriteMode {
  return (
    (operation === 'calendar.create' ? resource.create : resource.update) ||
    'deny'
  );
}

function parseWritePayload(
  operation: GoogleWriteOperation,
  params: Record<string, unknown>,
): StoredWritePayload {
  const allowed =
    operation === 'calendar.create'
      ? [
          'account',
          'resource',
          'summary',
          'from',
          'to',
          'description',
          'location',
        ]
      : [
          'account',
          'resource',
          'eventId',
          'summary',
          'from',
          'to',
          'description',
          'location',
        ];
  assertExactKeys(params, allowed);
  const accountAlias = params.account;
  const resourceAlias = params.resource;
  assertAlias(accountAlias, 'account');
  assertAlias(resourceAlias, 'resource');
  const values: Record<string, unknown> = {};
  if (operation === 'calendar.create') {
    assertString(params.summary, 'summary', 1000);
    assertString(params.from, 'from', 100);
    assertString(params.to, 'to', 100);
    values.summary = params.summary;
    values.from = params.from;
    values.to = params.to;
    const description = optionalString(params.description, 'description');
    const location = optionalString(params.location, 'location', 1000);
    if (description !== undefined) values.description = description;
    if (location !== undefined) values.location = location;
  } else {
    assertString(params.eventId, 'eventId', 300);
    if (!EVENT_ID_PATTERN.test(params.eventId)) {
      throw new Error('Invalid calendar event ID');
    }
    values.eventId = params.eventId;
    for (const [key, max] of [
      ['summary', 1000],
      ['from', 100],
      ['to', 100],
      ['description', 20_000],
      ['location', 1000],
    ] as const) {
      if (params[key] !== undefined) {
        if (
          typeof params[key] !== 'string' ||
          String(params[key]).length > max
        ) {
          throw new Error(`${key} must be a string`);
        }
        values[key] = params[key];
      }
    }
    if (Object.keys(values).length === 1) {
      throw new Error('Calendar update has no changes');
    }
  }
  return { operation, accountAlias, resourceAlias, values };
}

function proposalSummary(payload: StoredWritePayload): string {
  const v = payload.values;
  if (payload.operation === 'calendar.create') {
    return [
      `Create calendar event in ${payload.resourceAlias}`,
      `Title: ${String(v.summary)}`,
      `From: ${String(v.from)}`,
      `To: ${String(v.to)}`,
      v.location ? `Location: ${String(v.location)}` : '',
      v.description
        ? `Description:\n${String(v.description).slice(0, 1200)}`
        : '',
      'Attendees: disabled',
      'Notifications: none',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    `Update calendar event in ${payload.resourceAlias}`,
    `Event: ${String(v.eventId)}`,
    v.summary !== undefined ? `Title: ${String(v.summary)}` : '',
    v.from !== undefined ? `From: ${String(v.from)}` : '',
    v.to !== undefined ? `To: ${String(v.to)}` : '',
    v.location !== undefined ? `Location: ${String(v.location)}` : '',
    v.description !== undefined
      ? `Description:\n${String(v.description).slice(0, 1200)}`
      : '',
    'Attendees: unchanged and unavailable',
    'Notifications: none',
  ]
    .filter(Boolean)
    .join('\n');
}

function approvalPrompt(approval: GoogleApproval): string {
  return [
    'Google write approval required',
    '',
    approval.summary,
    '',
    `Approval: ${approval.id}`,
    `Expires: ${approval.expires_at}`,
    `Approve: /approve ${approval.id}`,
    `Reject: /reject ${approval.id}`,
  ].join('\n');
}

async function preparePayload(
  policy: GooglePolicy,
  payload: StoredWritePayload,
  sourceGroup: string,
): Promise<GoogleWriteMode> {
  const { resource, account } = calendarResource(
    policy,
    payload.resourceAlias,
    sourceGroup,
  );
  if (payload.accountAlias !== resource.account) {
    throw new Error(
      `Resource "${payload.resourceAlias}" belongs to account alias "${resource.account}"`,
    );
  }
  payload.values.resolvedAccountEmail = account.email;
  payload.values.resolvedCalendarId = resource.calendarId;
  if (payload.operation === 'calendar.update') {
    const snapshot = await readCalendarEvent(
      policy,
      resource,
      account,
      String(payload.values.eventId),
    );
    if (eventHasAttendees(snapshot)) {
      throw new Error(
        'Calendar updates are unavailable for events that already have attendees',
      );
    }
    payload.values.eventSnapshotSha256 = textHash(snapshot);
  }
  return writeMode(resource, payload.operation);
}

export async function proposeGoogleWrite(
  operation: GoogleWriteOperation,
  params: Record<string, unknown>,
  ctx: GoogleActionContext,
): Promise<string> {
  const payload = parseWritePayload(operation, params);
  const policy = loadGooglePolicy();
  const mode = await preparePayload(policy, payload, ctx.sourceGroup);
  if (mode === 'deny') {
    throw new Error(`${operation} is denied by Google policy`);
  }
  if (mode === 'auto') {
    throw new Error(
      'Google auto-write policy is reserved but not enabled; use manual approval',
    );
  }
  const payloadJson = canonicalJson(payload);
  const hash = textHash(payloadJson);
  const now = new Date();
  expirePendingGoogleApprovals(now);
  const existing = findActiveGoogleApproval(
    ctx.sourceGroup,
    operation,
    payload.resourceAlias,
    hash,
    now,
  );
  if (existing) {
    if (existing.state === 'pending') {
      await ctx.sendMessage(
        policy.approvals.telegramChatJid,
        approvalPrompt(existing),
        existing.id,
      );
    }
    return JSON.stringify({
      status: existing.state,
      approvalId: existing.id,
      expiresAt: existing.expires_at,
      deduplicated: true,
    });
  }
  const ttl = Math.min(Math.max(policy.approvals.ttlSeconds || 600, 60), 3600);
  let approval: GoogleApproval;
  try {
    approval = createGoogleApproval({
      id: `G-${randomBytes(5).toString('hex').toUpperCase()}`,
      source_group: ctx.sourceGroup,
      source_chat_jid: ctx.sourceChatJid,
      operation,
      account_alias: payload.accountAlias,
      resource_alias: payload.resourceAlias,
      payload_json: payloadJson,
      payload_hash: hash,
      summary: proposalSummary(payload),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttl * 1000).toISOString(),
    });
  } catch (err) {
    const raced = findActiveGoogleApproval(
      ctx.sourceGroup,
      operation,
      payload.resourceAlias,
      hash,
      now,
    );
    if (!raced) throw err;
    if (raced.state === 'pending') {
      await ctx.sendMessage(
        policy.approvals.telegramChatJid,
        approvalPrompt(raced),
        raced.id,
      );
    }
    return JSON.stringify({
      status: raced.state,
      approvalId: raced.id,
      expiresAt: raced.expires_at,
      deduplicated: true,
    });
  }
  await ctx.sendMessage(
    policy.approvals.telegramChatJid,
    approvalPrompt(approval),
    approval.id,
  );
  return JSON.stringify({
    status: 'pending_approval',
    approvalId: approval.id,
    expiresAt: approval.expires_at,
    approvalChatJid: policy.approvals.telegramChatJid,
  });
}

function parseStoredPayload(approval: GoogleApproval): StoredWritePayload {
  if (!approval.payload_json) throw new Error('Approval payload was erased');
  if (textHash(approval.payload_json) !== approval.payload_hash) {
    throw new Error('Approval payload hash mismatch');
  }
  return JSON.parse(approval.payload_json) as StoredWritePayload;
}

async function runMutation(
  policy: GooglePolicy,
  args: string[],
): Promise<string> {
  try {
    return await runGog(policy, args);
  } catch (err) {
    throw new GoogleMutationUncertainError(
      `${err instanceof Error ? err.message : String(err)}; external outcome is unknown`,
    );
  }
}

function assertFrozenTarget(
  payload: StoredWritePayload,
  resource: GoogleCalendarPolicy,
  account: GoogleAccountPolicy,
): void {
  if (
    payload.values.resolvedAccountEmail !== account.email ||
    payload.values.resolvedCalendarId !== resource.calendarId
  ) {
    throw new Error(
      'Google policy target changed after proposal; create a fresh proposal',
    );
  }
}

async function verifiedReadback(
  policy: GooglePolicy,
  resource: GoogleCalendarPolicy,
  account: GoogleAccountPolicy,
  eventId: string,
): Promise<{ eventId: string; verified: true; url?: string }> {
  try {
    const readback = await readCalendarEvent(
      policy,
      resource,
      account,
      eventId,
    );
    const url = extractString(readback, ['htmlLink', 'url']);
    return { eventId, verified: true, ...(url ? { url } : {}) };
  } catch (err) {
    throw new GoogleMutationUncertainError(
      `Calendar mutation returned but read-back failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function executePayload(
  approval: GoogleApproval,
  payload: StoredWritePayload,
): Promise<string> {
  const policy = loadGooglePolicy();
  const { resource, account } = calendarResource(
    policy,
    payload.resourceAlias,
    approval.source_group,
  );
  assertFrozenTarget(payload, resource, account);
  if (writeMode(resource, payload.operation) === 'deny') {
    throw new Error('Google policy now denies this operation');
  }
  const v = payload.values;
  if (payload.operation === 'calendar.create') {
    const mutation = await runMutation(policy, [
      'calendar',
      'create',
      resource.calendarId,
      '--summary',
      String(v.summary),
      '--from',
      String(v.from),
      '--to',
      String(v.to),
      ...(v.description !== undefined
        ? ['--description', String(v.description)]
        : []),
      ...(v.location !== undefined ? ['--location', String(v.location)] : []),
      '--send-updates',
      'none',
      ...commonGogArgs(account.email, 'calendar.create', false),
    ]);
    const eventId = extractString(mutation, ['eventId', 'id']);
    if (!eventId) {
      throw new GoogleMutationUncertainError(
        'Calendar create returned no event ID; external outcome is unknown',
      );
    }
    return JSON.stringify(
      await verifiedReadback(policy, resource, account, eventId),
    );
  }
  const eventId = String(v.eventId);
  const current = await readCalendarEvent(policy, resource, account, eventId);
  if (eventHasAttendees(current)) {
    throw new Error(
      'Calendar update blocked because the event now has attendees',
    );
  }
  if (
    typeof v.eventSnapshotSha256 !== 'string' ||
    textHash(current) !== v.eventSnapshotSha256
  ) {
    throw new Error(
      'Calendar event changed after proposal; create a fresh proposal',
    );
  }
  const args = ['calendar', 'update', resource.calendarId, eventId];
  for (const [key, flag] of [
    ['summary', '--summary'],
    ['from', '--from'],
    ['to', '--to'],
    ['description', '--description'],
    ['location', '--location'],
  ] as const) {
    if (v[key] !== undefined) args.push(flag, String(v[key]));
  }
  args.push(
    '--send-updates',
    'none',
    ...commonGogArgs(account.email, 'calendar.update', false),
  );
  await runMutation(policy, args);
  return JSON.stringify(
    await verifiedReadback(policy, resource, account, eventId),
  );
}

async function executeApproval(approvalId: string): Promise<GoogleApproval> {
  const claimed = claimGoogleApproval(approvalId);
  try {
    const result = await executePayload(claimed, parseStoredPayload(claimed));
    return finishGoogleApproval(approvalId, {
      state: 'succeeded',
      resultJson: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const uncertain = err instanceof GoogleMutationUncertainError;
    logger.error(
      {
        err,
        approvalId,
        operation: claimed.operation,
        outcome: uncertain ? 'needs_reconciliation' : 'failed',
      },
      'Google approval execution failed',
    );
    return finishGoogleApproval(
      approvalId,
      uncertain
        ? { state: 'needs_reconciliation', error: message }
        : { state: 'failed', error: message },
    );
  }
}

function completionMessage(approval: GoogleApproval): string {
  if (approval.state === 'needs_reconciliation') {
    return `Google write ${approval.id} has an unknown external outcome and needs reconciliation: ${approval.error}`;
  }
  if (approval.state === 'failed') {
    return `Google write ${approval.id} failed before a confirmed mutation: ${approval.error}`;
  }
  let link = '';
  if (approval.result_json) {
    try {
      const result = JSON.parse(approval.result_json) as Record<
        string,
        unknown
      >;
      if (typeof result.url === 'string') link = `\n${result.url}`;
    } catch {
      // Sanitized result parsing is best-effort.
    }
  }
  return `Google write ${approval.id} succeeded.${link}`;
}

function trackExecution(promise: Promise<unknown>): void {
  inFlightExecutions.add(promise);
  void promise.finally(() => inFlightExecutions.delete(promise));
}

export async function waitForGoogleExecutions(
  timeoutMs = 60_000,
): Promise<void> {
  if (inFlightExecutions.size === 0) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([
    Promise.allSettled([...inFlightExecutions]).then(() => undefined),
    timeout,
  ]);
  if (timer) clearTimeout(timer);
}

export function recoverGoogleApprovalWork(
  _groupIpcDirFor: (groupFolder: string) => string,
  notify: (chatJid: string, text: string) => Promise<void>,
): void {
  const expired = expirePendingGoogleApprovals();
  if (expired > 0) {
    logger.info({ expired }, 'Expired stale Google write proposals');
  }
  for (const approval of listGoogleApprovalsByState(['approved'])) {
    const work = executeApproval(approval.id)
      .then((completed) =>
        notify(completed.source_chat_jid, completionMessage(completed)),
      )
      .catch((err) =>
        logger.error(
          { err, approvalId: approval.id },
          'Failed to recover approved Google write',
        ),
      );
    trackExecution(work);
  }
  const reconcile = listGoogleApprovalsByState([
    'executing',
    'needs_reconciliation',
  ]);
  if (reconcile.length > 0) {
    try {
      const policy = loadGooglePolicy();
      void notify(
        policy.approvals.telegramChatJid,
        [
          'Google writes require reconciliation:',
          ...reconcile.map(
            (approval) => `${approval.id} (${approval.operation})`,
          ),
          'They will not be replayed automatically.',
        ].join('\n'),
      ).catch((err) =>
        logger.error(
          { err },
          'Failed to send Google reconciliation notification',
        ),
      );
    } catch (err) {
      logger.warn(
        { err, count: reconcile.length },
        'Cannot notify about Google reconciliation work',
      );
    }
  }
}

export async function handleGoogleApprovalCommand(
  command: string,
  rawId: string,
  chatJid: string,
  senderId: string,
  _groupIpcDirFor: (groupFolder: string) => string,
  notify: (chatJid: string, text: string) => Promise<void>,
): Promise<GoogleCommandOutcome> {
  const policy = loadGooglePolicy();
  if (
    chatJid !== policy.approvals.telegramChatJid ||
    !policy.approvals.telegramUserIds.includes(senderId)
  ) {
    throw new Error('You are not authorized to decide Google writes.');
  }
  const approvalId = rawId.trim().toUpperCase();
  if (!APPROVAL_ID_PATTERN.test(approvalId)) {
    throw new Error(`Usage: /${command} G-XXXXXXXXXX`);
  }
  expirePendingGoogleApprovals(new Date());
  const current = getGoogleApproval(approvalId);
  if (!current) throw new Error(`Unknown approval ${approvalId}`);
  if (current.state !== 'pending') {
    return { reply: `Google write ${approvalId} is already ${current.state}.` };
  }
  const decision = command === 'approve' ? 'approved' : 'rejected';
  const approval = decideGoogleApproval(
    approvalId,
    decision,
    chatJid,
    senderId,
  );
  if (decision === 'rejected') {
    if (approval.source_chat_jid !== chatJid) {
      await notify(
        approval.source_chat_jid,
        `Google write ${approvalId} was rejected.`,
      );
    }
    return { reply: `Rejected ${approvalId}.` };
  }
  const work = executeApproval(approvalId)
    .then(async (completed) => {
      const message = completionMessage(completed);
      await notify(completed.source_chat_jid, message);
      if (completed.source_chat_jid !== chatJid) {
        await notify(chatJid, message);
      }
    })
    .catch((err) =>
      logger.error(
        { err, approvalId },
        'Unexpected Google approval background failure',
      ),
    );
  trackExecution(work);
  return {
    reply: `Approved ${approvalId}; execution started. I will report the result in the requesting chat.`,
  };
}
