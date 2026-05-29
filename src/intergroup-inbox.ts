import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

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
