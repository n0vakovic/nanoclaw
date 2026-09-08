import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlDependencies, handleControlCommand } from './control.js';
import { NewMessage, RegisteredGroup } from './types.js';

const group = (folder: string, isMain = false): RegisteredGroup => ({
  name: folder,
  folder,
  isMain,
  trigger: '@Ras',
  added_at: '2026-09-08',
});
const message: NewMessage = {
  id: 'm1',
  chat_jid: 'tg:123',
  sender: '123',
  sender_name: 'Owner',
  content: '/status',
  timestamp: '2026-09-08T00:00:00Z',
};
let deps: ControlDependencies;
beforeEach(() => {
  deps = {
    groups: () => ({ 'tg:123': group('main', true), 'tg:-2': group('alpha') }),
    status: vi.fn(() => 'Build abc; ready'),
    jobs: vi.fn(() => 'J-123'),
    cancelJob: vi.fn(async () => 'Cancelled'),
    steerJob: vi.fn(() => 'Steered'),
    capture: vi.fn(() => 'incident-123'),
    reset: vi.fn(async () => {}),
    restart: vi.fn(),
  };
});
const command = (name: string, args = '', jid = 'tg:123', input = message) =>
  handleControlCommand(deps, name, args, jid, input);

describe('host recovery controls', () => {
  it.each(['status', 'jobs', 'cancel', 'clear', 'restart'])(
    'denies /%s from another sender even in the registered main chat',
    async (name) => {
      await expect(
        command(name, '', 'tg:123', { ...message, sender: '456' }),
      ).rejects.toThrow(/owner/);
      expect(deps.capture).not.toHaveBeenCalled();
      expect(deps.reset).not.toHaveBeenCalled();
      expect(deps.restart).not.toHaveBeenCalled();
      expect(deps.status).not.toHaveBeenCalled();
    },
  );
  it('rejects bot messages and main groups without a private owner binding', async () => {
    await expect(
      command('clear', '', 'tg:123', { ...message, is_bot_message: true }),
    ).rejects.toThrow(/owner/);
    deps.groups = () => ({ 'tg:-2': group('main', true) });
    await expect(command('clear', '', 'tg:-2')).rejects.toThrow(/owner/);
  });
  it('serves status immediately through host dependencies', async () => {
    expect(await command('status')).toEqual({ reply: 'Build abc; ready' });
    expect(deps.status).toHaveBeenCalledWith('tg:123', undefined);
    expect(deps.capture).not.toHaveBeenCalled();
    expect(deps.reset).not.toHaveBeenCalled();
  });
  it('persists clear evidence before resetting the session', async () => {
    const order: string[] = [];
    deps.capture = vi.fn(() => {
      order.push('capture');
      return 'incident-123';
    });
    deps.reset = vi.fn(async () => {
      order.push('reset');
    });
    const result = await command('clear');
    expect(order).toEqual(['capture', 'reset']);
    expect(deps.capture).toHaveBeenCalledWith('user_clear', 'tg:123', message);
    expect(deps.reset).toHaveBeenCalledWith('tg:123', true, message);
    expect(result.reply).toContain('incident-123');
  });
  it('refuses reset when incident persistence fails', async () => {
    deps.capture = vi.fn(() => {
      throw new Error('Disk full');
    });
    await expect(command('clear')).rejects.toThrow('Disk full');
    expect(deps.reset).not.toHaveBeenCalled();
  });
  it('defers restart until after its evidence-bearing reply', async () => {
    const result = await command('restart');
    expect(deps.capture).toHaveBeenCalledWith(
      'user_restart',
      'tg:123',
      message,
    );
    expect(result.reply).toContain('incident-123');
    expect(deps.restart).not.toHaveBeenCalled();
    expect(deps.reset).not.toHaveBeenCalled();
    result.afterReply!();
    expect(deps.restart).toHaveBeenCalledTimes(1);
  });
  it('restricts restart to private main and routes job cancellation by current group', async () => {
    await expect(command('restart', '', 'tg:-2')).rejects.toThrow(
      /private main/,
    );
    await command('cancel', 'J-ABCDEF123456', 'tg:-2');
    expect(deps.cancelJob).toHaveBeenCalledWith('alpha', 'J-ABCDEF123456');
    expect(deps.reset).not.toHaveBeenCalled();
  });
});
