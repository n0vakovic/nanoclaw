import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export const VOICE_MODE_RULE =
  '[VOICE MODE ACTIVE] Stay in voice mode until the user asks to leave and you call exit_voice_mode. After an incoming voice message, send a voice reply with send_voice_note; text may accompany it. Never silently switch to text-only. Do not automatically convert an existing text reply to audio.';

/** Per-chat state survives SDK sessions and container restarts in the IPC mount. */
export class VoiceMode {
  private readonly statePath: string;
  constructor(
    private readonly ipcDir: string,
    chatJid: string,
  ) {
    this.statePath = path.join(
      ipcDir,
      'voice-mode',
      `${Buffer.from(chatJid).toString('hex')}.json`,
    );
  }

  isActive(): boolean {
    try {
      return (
        JSON.parse(fs.readFileSync(this.statePath, 'utf8')).active === true
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  setActive(active: boolean): string {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ active }));
    fs.renameSync(temporary, this.statePath);
    return active ? VOICE_MODE_RULE : '[VOICE MODE DEACTIVATED]';
  }

  deliveryPath(scope: string): string {
    return path.join(this.ipcDir, 'voice-deliveries', `${scope}.json`);
  }

  deliveredSince(scope: string, since: number): boolean {
    try {
      return (
        JSON.parse(fs.readFileSync(this.deliveryPath(scope), 'utf8'))
          .deliveredAt >= since
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}

/** One reminder per inbound burst prevents an unavailable TTS service causing an infinite Stop loop. */
export class VoiceReplyGuard {
  private voiceRequired = false;
  private since = Date.now();
  private reminded = false;
  constructor(
    private readonly mode: VoiceMode,
    private readonly scope: string,
  ) {}

  acceptPrompt(prompt: string): string {
    // Only inspect message attributes supplied by the host, never quoted reply text.
    const messages = [...prompt.matchAll(/<message\b([^>]*)>/g)];
    if (messages.length) {
      const hasVoice = messages.some((message) =>
        /\bmodality="voice"/.test(message[1]),
      );
      // A text follow-up arriving while a voice reply is still pending must not
      // accidentally release the obligation for that same in-flight turn.
      if (hasVoice) {
        this.voiceRequired = true;
        this.since = Date.now();
        this.reminded = false;
      }
    }
    return this.mode.isActive() ? `${prompt}\n\n${VOICE_MODE_RULE}` : prompt;
  }

  private finishTurn(): void {
    this.voiceRequired = false;
    this.reminded = false;
  }

  reminder(): string | undefined {
    if (
      !this.voiceRequired ||
      !this.mode.isActive() ||
      this.mode.deliveredSince(this.scope, this.since)
    )
      return;
    return `${VOICE_MODE_RULE} You have only sent text so far in response to the user's voice message. Send a voice reply now. If voice delivery fails, report the actual error clearly; mode remains active.`;
  }

  stop(): { decision?: 'block'; reason?: string } {
    const reason = this.reminder();
    if (!reason || this.reminded) {
      // Retire the current obligation at the actual Stop boundary. Result
      // events may be consumed after the next prompt hook has already fired.
      this.finishTurn();
      return {};
    }
    this.reminded = true;
    return { decision: 'block', reason };
  }
}
