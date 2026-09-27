/** Collect visible text across tool calls until the SDK completes a turn. */
export class ReplyCollector {
  private parts: string[] = [];
  private seen = new Set<string>();

  add(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const record = message as {
      type?: string;
      uuid?: string;
      parent_tool_use_id?: string | null;
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
    // Subagent output belongs to its parent tool, not directly to the chat.
    if (record.type !== 'assistant' || record.parent_tool_use_id) return;
    if (record.uuid && this.seen.has(record.uuid)) return;
    if (record.uuid) this.seen.add(record.uuid);
    const text = record.message?.content
      ?.filter(
        (block) => block.type === 'text' && typeof block.text === 'string',
      )
      .map((block) => block.text!.trim())
      .filter(Boolean)
      .join('\n\n');
    if (text) this.parts.push(text);
  }

  finish(result?: string | null): string | null {
    const final = result?.trim();
    // The SDK normally repeats the final assistant message in result.
    if (final && final !== this.parts.at(-1)) this.parts.push(final);
    const reply = this.parts.join('\n\n') || null;
    this.parts = [];
    this.seen.clear();
    return reply;
  }
}
