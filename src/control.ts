import { NewMessage, RegisteredGroup } from './types.js';

export interface ControlDependencies {
  groups(): Record<string, RegisteredGroup>;
  status(groupJid: string, jobId?: string): string;
  jobs(groupFolder: string): string;
  cancelJob(groupFolder: string, jobId: string): Promise<string>;
  steerJob(groupFolder: string, jobId: string, instruction: string): string;
  capture(reason: string, jid: string, message: NewMessage): string;
  reset(jid: string, clear: boolean, message: NewMessage): Promise<void>;
  restart(): void;
}
export const CONTROL_COMMANDS = [
  'status',
  'jobs',
  'cancel',
  'clear',
  'restart',
  'steer',
];

/** Owner-only commands bypass the LLM. A private main Telegram chat binds owner identity. */
export async function handleControlCommand(
  deps: ControlDependencies,
  command: string,
  args: string,
  jid: string,
  message: NewMessage,
): Promise<{ reply: string; afterReply?: () => void }> {
  const groups = deps.groups();
  const group = groups[jid];
  const owner = Object.entries(groups).find(
    ([key, g]) => g.isMain && /^tg:[1-9][0-9]*$/.test(key),
  );
  if (
    !group ||
    !owner ||
    message.sender !== owner[0].slice(3) ||
    message.is_bot_message
  ) {
    throw new Error(
      'Recovery commands require the owner of the private main chat.',
    );
  }
  if (command === 'status')
    return { reply: deps.status(jid, args.trim() || undefined) };
  if (command === 'jobs') return { reply: deps.jobs(group.folder) };
  if (command === 'steer') {
    const match = /^(J-[A-F0-9]{12})\s+([\s\S]+)$/.exec(args.trim());
    if (!match) throw new Error('Usage: /steer J-ID instruction');
    return { reply: deps.steerJob(group.folder, match[1], match[2]) };
  }
  if (command === 'cancel' && args.trim())
    return { reply: await deps.cancelJob(group.folder, args.trim()) };
  if (!['cancel', 'clear', 'restart'].includes(command))
    throw new Error('Unknown recovery command');
  if (args.trim()) throw new Error(`/${command} takes no arguments`);
  if (command === 'restart' && !group.isMain)
    throw new Error('/restart is available only in the private main chat');
  const incident = deps.capture(`user_${command}`, jid, message);
  if (command === 'restart')
    return {
      reply: `Restarting NanoClaw. Incident ${incident}. History and memory are preserved; interrupted work will not be silently replayed.`,
      afterReply: deps.restart,
    };
  await deps.reset(jid, command === 'clear', message);
  return {
    reply:
      command === 'clear'
        ? `Fresh conversation ready. Previous session and memory preserved. Incident ${incident}.`
        : `Current work cancelled. History preserved. Incident ${incident}. Send a new message to continue.`,
  };
}
