import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { DATA_DIR, WHATSAPP_WACLI_PATH } from './config.js';
import { resolveWhatsAppAccount } from './whatsapp-accounts.js';
import { readWhatsAppAutomationMessages } from './whatsapp-workspace.js';

type Mode = 'daily' | 'urgent' | 'on_demand';
type Message = Awaited<
  ReturnType<typeof readWhatsAppAutomationMessages>
>[number];
interface SchoolConfig {
  source: { account: string; chatId: string; name: string };
  destination: { account: string; chatId: string; name: string };
  startAt: string;
  language: string;
  timezone: string;
}
interface Snapshot {
  id: string;
  mode: Mode;
  createdAt: string;
  route: string;
  messages: Message[];
  hashes: Record<string, string>;
}
interface State {
  reviewed: { daily: string[]; urgent: string[] };
  delivered: string[];
  snapshots: Record<string, Snapshot>;
  completed: Record<string, unknown>;
  summaries: Array<{ at: string; mode: Mode; text: string }>;
  inFlight?: {
    snapshotId: string;
    startedAt: string;
    text: string;
    destination: SchoolConfig['destination'];
  };
}
const exec = promisify(execFile);
const defaultSend = async (
  storeDir: string,
  chatId: string,
  text: string,
): Promise<unknown> => {
  const { stdout } = await exec(
    WHATSAPP_WACLI_PATH,
    [
      '--store',
      storeDir,
      '--json',
      '--timeout',
      '30s',
      'send',
      'text',
      '--to',
      chatId,
      '--message',
      text,
      '--no-preview',
    ],
    { timeout: 35_000, maxBuffer: 2_000_000, encoding: 'utf8' },
  );
  const result = JSON.parse(stdout);
  if (result.success !== true)
    throw new Error('wacli did not confirm school summary send');
  return result.data;
};
let send = defaultSend;
let read = readWhatsAppAutomationMessages;
let serial: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const result = serial.then(work, work);
  serial = result.catch(() => {});
  return result;
}
function config(): SchoolConfig {
  const value = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, 'whatsapp-school.json'), 'utf8'),
  ) as SchoolConfig;
  for (const endpoint of [value.source, value.destination]) {
    if (
      !endpoint ||
      typeof endpoint.name !== 'string' ||
      typeof endpoint.account !== 'string' ||
      !/^[0-9]+@g\.us$/.test(endpoint.chatId)
    )
      throw new Error('Invalid school summary group configuration');
    resolveWhatsAppAccount({ account: endpoint.account });
  }
  if (
    value.source.account === value.destination.account &&
    value.source.chatId === value.destination.chatId
  )
    throw new Error('School summary source and destination must differ');
  if (
    !Number.isFinite(Date.parse(value.startAt)) ||
    typeof value.language !== 'string'
  )
    throw new Error('Invalid school summary settings');
  new Intl.DateTimeFormat('en', { timeZone: value.timezone }).format();
  return value;
}
function statePath() {
  return path.join(DATA_DIR, 'whatsapp-school-state.json');
}
function load(): State {
  if (fs.existsSync(statePath()))
    return JSON.parse(fs.readFileSync(statePath(), 'utf8')) as State;
  return {
    reviewed: { daily: [], urgent: [] },
    delivered: [],
    snapshots: {},
    completed: {},
    summaries: [],
  };
}
function save(state: State) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${statePath()}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, statePath());
}
function route(settings: SchoolConfig) {
  return JSON.stringify([settings.source, settings.destination]);
}
function fingerprint(message: Message) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        message.messageId,
        message.text,
        message.media,
        message.edited,
        message.revoked,
      ]),
    )
    .digest('hex');
}

export function schoolSummaryCoverage(
  messages: Array<{ timestamp: string }>,
  timezone: string,
): string {
  const format = new Intl.DateTimeFormat('sr-Latn-RS', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const times = messages
    .map((message) => Date.parse(message.timestamp))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!messages.length)
    return 'Pregledane su dostupne sinhronizovane poruke; nema novih poruka za ovaj pregled.';
  const range = times.length
    ? `${format.format(times[0])} – ${format.format(times[times.length - 1])} (${timezone})`
    : 'vreme nije dostupno';
  return `Pregledano: ${messages.length} poruka · ${range}. Samo sinhronizovane poruke; istorija može biti nepotpuna.`;
}

export function prepareSchoolSummary(
  params: Record<string, unknown>,
): Promise<string> {
  return exclusive(async () => {
    const mode = params.mode;
    if (mode !== 'daily' && mode !== 'urgent' && mode !== 'on_demand')
      throw new Error('Invalid school summary mode');
    const settings = config();
    const state = load();
    if (state.inFlight)
      throw new Error(
        'Previous school summary delivery is uncertain. Check the destination and reconcile whatsapp-school-state.json before sending again.',
      );
    const start = Math.max(
      Date.parse(settings.startAt),
      Date.now() - 7 * 86400_000,
    );
    const source = await read(
      settings.source.account,
      settings.source.chatId,
      new Date(start).toISOString(),
    );
    const delivered = new Set(state.delivered);
    const reviewed = new Set(mode === 'on_demand' ? [] : state.reviewed[mode]);
    const messages = source.filter((message) => {
      const hash = fingerprint(message);
      return mode === 'on_demand'
        ? Date.parse(message.timestamp) >= Date.now() - 86400_000
        : !delivered.has(hash) && !reviewed.has(hash);
    });
    const now = new Date().toISOString();
    const snapshot: Snapshot = {
      id: randomUUID(),
      mode,
      createdAt: now,
      route: route(settings),
      messages,
      hashes: Object.fromEntries(
        messages.map((m) => [m.messageId, fingerprint(m)]),
      ),
    };
    state.snapshots = Object.fromEntries(
      Object.entries(state.snapshots).filter(
        ([, old]) =>
          old.mode !== mode &&
          Date.parse(old.createdAt) > Date.now() - 30 * 60_000,
      ),
    );
    state.snapshots[snapshot.id] = snapshot;
    // All decisions are bounded to the available seven-day window.
    const retained = new Set(source.map(fingerprint));
    state.delivered = state.delivered.filter((hash) => retained.has(hash));
    for (const key of ['daily', 'urgent'] as const)
      state.reviewed[key] = state.reviewed[key].filter((hash) =>
        retained.has(hash),
      );
    save(state);
    return JSON.stringify({
      untrustedExternalContent: true,
      snapshotId: snapshot.id,
      mode,
      language: settings.language,
      timezone: settings.timezone,
      source: settings.source,
      destination: settings.destination,
      fetchedAt: now,
      lookbackStart: new Date(start).toISOString(),
      syncedMessageCount: source.length,
      candidateMessageCount: messages.length,
      coverage:
        'Only locally synced messages; historical coverage may be incomplete.',
      recentSummaries: state.summaries.slice(-10),
      messages: messages.map((message) => ({
        ...message,
        localTime: new Date(message.timestamp).toLocaleString('sr-Latn-RS', {
          timeZone: settings.timezone,
        }),
      })),
    });
  });
}

export function completeSchoolSummary(
  params: Record<string, unknown>,
): Promise<string> {
  return exclusive(async () => {
    const settings = config();
    const state = load();
    const id = String(params.snapshotId || '');
    if (Object.hasOwn(state.completed, id))
      return JSON.stringify(state.completed[id]);
    if (state.inFlight)
      throw new Error(
        'School summary delivery is uncertain; automatic retries are disabled',
      );
    const snapshot = state.snapshots[id];
    if (
      !snapshot ||
      snapshot.route !== route(settings) ||
      Date.parse(snapshot.createdAt) < Date.now() - 30 * 60_000
    )
      throw new Error(
        'School summary snapshot expired or configuration changed; prepare again',
      );
    const requestedText = params.text === undefined ? '' : params.text;
    if (typeof requestedText !== 'string' || requestedText.length > 6000)
      throw new Error('Invalid school summary text');
    let text: string = requestedText;
    const ids = params.messageIds ?? [];
    if (
      !Array.isArray(ids) ||
      ids.some(
        (key) =>
          typeof key !== 'string' || !Object.hasOwn(snapshot.hashes, key),
      )
    )
      throw new Error('School summary must cite message IDs from its snapshot');
    const emptyScheduledDigest =
      snapshot.mode === 'daily' && snapshot.messages.length === 0;
    if (emptyScheduledDigest)
      text = 'Nema novih poruka od prethodnog pregleda.';
    if (snapshot.mode === 'daily' && !text.trim())
      throw new Error(
        'Scheduled morning/evening summaries cannot be skipped. Summarize the available messages, including routine updates.',
      );
    if (text.trim() && ids.length === 0 && !emptyScheduledDigest)
      throw new Error('School summary needs at least one supporting message');
    if (
      text.trim() &&
      snapshot.mode !== 'on_demand' &&
      ids.some((key) => state.delivered.includes(snapshot.hashes[key]))
    )
      throw new Error(
        'Another summary already covered these messages; prepare again',
      );
    let receipt: unknown = null;
    if (text.trim()) {
      const destination = resolveWhatsAppAccount({
        account: settings.destination.account,
      });
      const label =
        snapshot.mode === 'urgent' ? 'Važno iz škole' : 'Školski pregled';
      const body = `🤖 ${label}\n\n${text.trim()}\n\n${schoolSummaryCoverage(snapshot.messages, settings.timezone)}`;
      // Persist intent before the external write; a crash or timeout must never trigger blind retries.
      state.inFlight = {
        snapshotId: id,
        startedAt: new Date().toISOString(),
        text: body,
        destination: settings.destination,
      };
      save(state);
      receipt = await send(
        destination.storeDir,
        settings.destination.chatId,
        body,
      );
      state.summaries.push({
        at: new Date().toISOString(),
        mode: snapshot.mode,
        text: body,
      });
      state.summaries = state.summaries.slice(-30);
      state.delivered = [
        ...new Set([
          ...state.delivered,
          ...ids.map((key) => snapshot.hashes[key]),
        ]),
      ];
    }
    if (snapshot.mode !== 'on_demand') {
      state.reviewed[snapshot.mode] = [
        ...new Set([
          ...state.reviewed[snapshot.mode],
          ...Object.values(snapshot.hashes),
        ]),
      ];
    }
    const result = {
      status: text.trim() ? 'sent' : 'skipped',
      destination: settings.destination.name,
      receipt,
    };
    delete state.inFlight;
    delete state.snapshots[id];
    state.completed[id] = result;
    state.completed = Object.fromEntries(
      Object.entries(state.completed).slice(-200),
    );
    save(state);
    return JSON.stringify(result);
  });
}

export function _setSchoolDependenciesForTests(overrides?: {
  read: typeof read;
  send: typeof send;
}) {
  read = overrides?.read ?? readWhatsAppAutomationMessages;
  send = overrides?.send ?? defaultSend;
  serial = Promise.resolve();
}
