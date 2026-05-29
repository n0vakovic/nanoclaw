import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { RegisteredGroup } from './types.js';

export type IntergroupInboxPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface IntergroupInboxItem {
  id: string;
  sourceGroup: string;
  sourceName: string;
  sourceJid: string;
  mainGroup: string;
  mainJid: string;
  subject: string;
  body: string;
  priority: IntergroupInboxPriority;
  createdAt: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
}

const VALID_ID = /^[A-Za-z0-9._-]+$/;

export function parseInboxPriority(value: unknown): IntergroupInboxPriority {
  return value === 'low' ||
    value === 'high' ||
    value === 'urgent' ||
    value === 'normal'
    ? value
    : 'normal';
}

export function parseInboxItemId(value: unknown): string {
  if (typeof value !== 'string' || !VALID_ID.test(value)) {
    throw new Error(`Invalid inbox item id "${String(value)}"`);
  }
  return value;
}

function inboxDir(mainGroup: string): string {
  return path.join(DATA_DIR, 'ipc', mainGroup, 'intergroup-inbox');
}

function inboxItemPath(mainGroup: string, id: string): string {
  return path.join(inboxDir(mainGroup), `${parseInboxItemId(id)}.json`);
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmpPath, filePath);
}

export function createIntergroupInboxItem(opts: {
  sourceGroup: string;
  registeredGroups: Record<string, RegisteredGroup>;
  surfaceId?: string;
  subject?: string;
  body?: string;
  priority?: string;
}): IntergroupInboxItem {
  const sourceEntry = Object.entries(opts.registeredGroups).find(
    ([, group]) => group.folder === opts.sourceGroup,
  );
  const mainEntry = Object.entries(opts.registeredGroups).find(
    ([, group]) => group.isMain === true,
  );
  if (!sourceEntry || !mainEntry) {
    throw new Error('Missing registered source or main group');
  }

  const [sourceJid, source] = sourceEntry;
  const [mainJid, main] = mainEntry;
  if (source.folder === main.folder) {
    throw new Error('Main group cannot surface to itself');
  }
  if (typeof opts.body !== 'string' || !opts.body.trim()) {
    throw new Error('surface_to_main requires a non-empty body');
  }

  const item = {
    id:
      opts.surfaceId ||
      `surface-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sourceGroup: opts.sourceGroup,
    sourceName: source.name,
    sourceJid,
    mainGroup: main.folder,
    mainJid,
    subject:
      typeof opts.subject === 'string' && opts.subject.trim()
        ? opts.subject.trim()
        : `Surfaced from ${source.name}`,
    body: opts.body.trim(),
    priority: parseInboxPriority(opts.priority),
    createdAt: new Date().toISOString(),
  };

  return writeIntergroupInboxItem(item);
}

export function writeIntergroupInboxItem(
  item: IntergroupInboxItem,
): IntergroupInboxItem {
  parseInboxItemId(item.id);
  writeJsonAtomic(inboxItemPath(item.mainGroup, item.id), item);

  const auditPath = path.join(DATA_DIR, 'intergroup-inbox.jsonl');
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.appendFileSync(auditPath, JSON.stringify(item) + '\n');
  return item;
}

export function queueIntergroupInboxNotification(
  item: IntergroupInboxItem,
): void {
  const messagesDir = path.join(DATA_DIR, 'ipc', item.mainGroup, 'messages');
  const messagePath = path.join(
    messagesDir,
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  writeJsonAtomic(messagePath, {
    type: 'message',
    chatJid: item.mainJid,
    text: `[${item.priority.toUpperCase()} from ${item.sourceName}]\n${item.subject}\n\n${item.body}`,
    groupFolder: item.mainGroup,
    timestamp: new Date().toISOString(),
  });
}

export function listIntergroupInboxItems(
  mainGroup: string,
  opts: { includeAcknowledged?: boolean; limit?: number } = {},
): IntergroupInboxItem[] {
  const dir = inboxDir(mainGroup);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const filePath = path.join(dir, file);
      return JSON.parse(
        fs.readFileSync(filePath, 'utf-8'),
      ) as IntergroupInboxItem;
    })
    .filter((item) => opts.includeAcknowledged || !item.acknowledgedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, opts.limit ?? 50);
}

export function acknowledgeIntergroupInboxItem(
  mainGroup: string,
  id: string,
  acknowledgedBy: string,
): IntergroupInboxItem {
  const itemId = parseInboxItemId(id);
  const filePath = inboxItemPath(mainGroup, itemId);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Inbox item not found: ${itemId}`);
  }
  const item = JSON.parse(
    fs.readFileSync(filePath, 'utf-8'),
  ) as IntergroupInboxItem;
  const updated = {
    ...item,
    acknowledgedAt: new Date().toISOString(),
    acknowledgedBy,
  };
  writeJsonAtomic(filePath, updated);
  return updated;
}
