import fs from 'fs';
import path from 'path';

import {
  WHATSAPP_ACCOUNTS_FILE,
  WHATSAPP_STORE_DIR,
  WHATSAPP_SYNC_SERVICE,
} from './config.js';

export interface WhatsAppAlias {
  chatId: string;
  name: string;
}
export interface WhatsAppAccount {
  id: string;
  storeDir: string;
  syncService: string;
  aliases: Record<string, WhatsAppAlias>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('whatsapp: invalid accounts configuration');
  return value as Record<string, unknown>;
}

export function whatsappAccounts(): WhatsAppAccount[] {
  const accounts: WhatsAppAccount[] = [
    {
      id: 'default',
      storeDir: WHATSAPP_STORE_DIR,
      syncService: WHATSAPP_SYNC_SERVICE,
      aliases: {},
    },
  ];
  if (!fs.existsSync(WHATSAPP_ACCOUNTS_FILE)) return accounts;
  const config = object(
    JSON.parse(fs.readFileSync(WHATSAPP_ACCOUNTS_FILE, 'utf8')),
  );
  for (const [id, raw] of Object.entries(object(config.accounts))) {
    const entry = object(raw);
    if (
      id === 'default' ||
      !/^[a-z][a-z0-9_-]{0,31}$/.test(id) ||
      typeof entry.storeDir !== 'string' ||
      !path.isAbsolute(entry.storeDir) ||
      typeof entry.syncService !== 'string' ||
      !/^[A-Za-z0-9_.@-]+\.service$/.test(entry.syncService)
    )
      throw new Error('whatsapp: invalid account configuration');
    const aliases: Record<string, WhatsAppAlias> = Object.create(null);
    for (const [alias, rawTarget] of Object.entries(
      object(entry.aliases ?? {}),
    )) {
      const target = object(rawTarget);
      const key = alias.trim().toLowerCase();
      if (
        !key ||
        Object.hasOwn(aliases, key) ||
        typeof target.chatId !== 'string' ||
        !/^[A-Za-z0-9@._:-]{1,256}$/.test(target.chatId) ||
        typeof target.name !== 'string' ||
        !target.name.trim()
      )
        throw new Error('whatsapp: invalid chat alias configuration');
      aliases[key] = { chatId: target.chatId, name: target.name };
    }
    accounts.push({
      id,
      storeDir: entry.storeDir,
      syncService: entry.syncService,
      aliases,
    });
  }
  return accounts;
}

export function resolveWhatsAppAccount(
  params: Record<string, unknown>,
): WhatsAppAccount {
  const accounts = whatsappAccounts();
  if (params.account !== undefined) {
    const found = accounts.find((a) => a.id === params.account);
    if (!found) throw new Error('whatsapp: unknown account');
    return found;
  }
  const references = Array.isArray(params.chatNames)
    ? params.chatNames
    : [params.chatId];
  const inferred = new Set<WhatsAppAccount>();
  for (const value of references) {
    if (typeof value !== 'string') continue;
    for (const account of accounts)
      if (Object.hasOwn(account.aliases, value.trim().toLowerCase()))
        inferred.add(account);
  }
  if (inferred.size > 1)
    throw new Error(
      'whatsapp: aliases span multiple accounts; specify one account per request',
    );
  return [...inferred][0] ?? accounts[0];
}

export function whatsappAlias(
  account: WhatsAppAccount,
  value: string,
): WhatsAppAlias | undefined {
  const key = value.trim().toLowerCase();
  return Object.hasOwn(account.aliases, key) ? account.aliases[key] : undefined;
}
