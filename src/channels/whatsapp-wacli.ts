import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { DATA_DIR, WHATSAPP_WACLI_PATH } from '../config.js';
import { resolveWhatsAppAccount } from '../whatsapp-accounts.js';
import { logger } from '../logger.js';
import type { Channel } from '../types.js';
import { registerChannel, type ChannelOpts } from './registry.js';

export interface RasConversation {
  account: string;
  chatId: string;
  name: string;
  groupFolder: string;
  emailSourceGroup: string;
}
export function rasConversation(): RasConversation | null {
  const file = path.join(DATA_DIR, 'whatsapp-school.json');
  if (!fs.existsSync(file)) return null;
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!config.conversation?.enabled) return null;
  if (
    !/^[a-zA-Z0-9_-]+$/.test(config.conversation.groupFolder) ||
    !/^\d+@g\.us$/.test(config.destination?.chatId)
  )
    throw new Error('Invalid Ras conversation configuration');
  return { ...config.destination, ...config.conversation };
}
export function isRasTrigger(text: string, fromMe: boolean): boolean {
  if (fromMe && /^\s*🤖/.test(text)) return false;
  return /(?:^|\s)@Ras\b/i.test(text);
}
type Runner = (
  file: string,
  args: string[],
  options: object,
) => Promise<{ stdout: string }>;
const execute = promisify(execFile) as Runner;
interface Cursor {
  timestamp: string;
  seen: string[];
  pendingSend?: string;
}

export class WacliConversationChannel implements Channel {
  name = 'whatsapp-wacli';
  private timer?: ReturnType<typeof setTimeout>;
  private connected = false;
  private running?: Promise<void>;
  private sendQueue: Promise<unknown> = Promise.resolve();
  private state: Cursor;
  private readonly stateFile = path.join(
    DATA_DIR,
    'whatsapp-conversation-state.json',
  );
  constructor(
    private config: RasConversation,
    private opts: ChannelOpts,
    private run: Runner = execute,
  ) {
    this.state = fs.existsSync(this.stateFile)
      ? JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
      : { timestamp: new Date().toISOString(), seen: [] };
  }
  private save() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(this.state), {
      mode: 0o600,
    });
    fs.renameSync(`${this.stateFile}.tmp`, this.stateFile);
  }
  private async command(args: string[], write = false) {
    const account = resolveWhatsAppAccount({ account: this.config.account });
    const result = await this.run(
      WHATSAPP_WACLI_PATH,
      [
        '--store',
        account.storeDir,
        '--json',
        ...(write ? [] : ['--read-only']),
        '--timeout',
        '30s',
        ...args,
      ],
      { timeout: 35_000, maxBuffer: 2_000_000, encoding: 'utf8' },
    );
    const parsed = JSON.parse(result.stdout);
    if (parsed.success !== true)
      throw new Error('wacli conversation command failed');
    return parsed.data;
  }
  async connect() {
    this.connected = true;
    this.save();
    const loop = async () => {
      if (!this.connected) return;
      this.running = this.poll().catch((err) =>
        logger.error({ err }, 'Ras WhatsApp polling failed'),
      );
      await this.running;
      if (this.connected) this.timer = setTimeout(loop, 5000);
    };
    void loop();
  }
  async poll() {
    const group = this.opts.registeredGroups()[this.config.chatId];
    if (!group || group.folder !== this.config.groupFolder || group.isMain)
      return;
    const after = new Date(
      Date.parse(this.state.timestamp) - 1000,
    ).toISOString();
    const result = await this.command([
      'messages',
      'list',
      '--chat',
      this.config.chatId,
      '--after',
      after,
      '--asc',
      '--limit',
      '1000',
    ]);
    const messages = result.messages;
    if (!Array.isArray(messages))
      throw new Error('Invalid wacli conversation messages');
    if (messages.length >= 1000)
      throw new Error(
        'Ras conversation backlog reached limit; checkpoint retained for review',
      );
    const seen = new Set(this.state.seen);
    for (const message of messages) {
      if (
        !message.MsgID ||
        seen.has(message.MsgID) ||
        !Number.isFinite(Date.parse(message.Timestamp))
      )
        continue;
      const text = String(message.Text || '');
      if (
        isRasTrigger(text, message.FromMe === true) &&
        !message.Revoked &&
        !message.DeletedForMe
      ) {
        // Use arrival time: the shared router cursor may already be ahead of delayed WhatsApp sync.
        const timestamp = new Date().toISOString();
        this.opts.onChatMetadata(
          this.config.chatId,
          timestamp,
          this.config.name,
        );
        this.opts.onMessage(this.config.chatId, {
          id: message.MsgID,
          chat_jid: this.config.chatId,
          sender: String(message.SenderJID || ''),
          sender_name: String(
            message.SenderName || (message.FromMe ? 'Milan' : 'Family member'),
          ),
          content: text,
          timestamp,
          is_from_me: message.FromMe === true,
          is_bot_message: false,
        });
      }
      seen.add(message.MsgID);
      if (message.Timestamp > this.state.timestamp)
        this.state.timestamp = message.Timestamp;
    }
    this.state.seen = [...seen].slice(-2000);
    this.save();
  }
  sendMessage(jid: string, text: string): Promise<void> {
    const work = async () => {
      if (!this.ownsJid(jid))
        throw new Error('Ras can only reply to the configured family group');
      if (this.state.pendingSend)
        throw new Error(
          'Previous Ras reply delivery is uncertain; inspect before retrying',
        );
      const body = `🤖 Ras\n\n${text.replace(/^\s*🤖 Ras\s*/, '').trim()}`;
      if (body.length > 12000) throw new Error('Ras reply is too long');
      this.state.pendingSend = body;
      this.save();
      await this.command(
        ['send', 'text', '--to', jid, '--message', body, '--no-preview'],
        true,
      );
      delete this.state.pendingSend;
      this.save();
    };
    const result = this.sendQueue.then(work, work);
    this.sendQueue = result.catch(() => {});
    return result;
  }
  isConnected() {
    return this.connected;
  }
  ownsJid(jid: string) {
    return jid === this.config.chatId;
  }
  async disconnect() {
    this.connected = false;
    clearTimeout(this.timer);
    await this.running;
    await this.sendQueue;
  }
}
registerChannel('whatsapp-wacli', (opts) => {
  const config = rasConversation();
  return config ? new WacliConversationChannel(config, opts) : null;
});
