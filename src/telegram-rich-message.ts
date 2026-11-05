/** Convert Bot API rich text into the text shape understood by our channel. */
function inlineText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(inlineText).join('');
  if (!value || typeof value !== 'object') return '';
  const node = value as Record<string, unknown>;
  return inlineText(node.text);
}

function blockText(value: unknown): string {
  if (Array.isArray(value)) return value.map(blockText).join('\n');
  if (!value || typeof value !== 'object') return inlineText(value);
  const node = value as Record<string, unknown>;
  const parts: string[] = [];
  if (node.text !== undefined) parts.push(inlineText(node.text));
  for (const key of ['title', 'caption']) {
    if (node[key] !== undefined) parts.push(inlineText(node[key]));
  }
  for (const key of ['blocks', 'items', 'rows', 'cells']) {
    if (node[key] !== undefined) parts.push(blockText(node[key]));
  }
  const text = parts.join('\n');
  return typeof node.label === 'string' ? `${node.label} ${text}` : text;
}

export function telegramRichMessageText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  return blockText((value as Record<string, unknown>).blocks);
}

/** Run after durable journaling, before grammY's message:text filter. */
export function normalizeTelegramRichMessage(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const message = value as Record<string, unknown>;
  if (typeof message.text !== 'string' && message.rich_message) {
    message.text =
      telegramRichMessageText(message.rich_message) ||
      '[Rich message with no readable text; original payload retained in Telegram ingress receipt]';
  }
  normalizeTelegramRichMessage(message.reply_to_message);
}
