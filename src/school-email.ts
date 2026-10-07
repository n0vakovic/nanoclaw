import {
  googleGmailMessageRead,
  googleGmailSearch,
} from './google-workspace.js';

export interface SchoolEmailConfig {
  alias: string;
  senderDomain: string;
}
// Remove only the transport wrapper. The combined summary payload remains explicitly untrusted.
function content(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(
      /^<<<EXTERNAL_UNTRUSTED_CONTENT id="[^"]+">>>\nSource: google_api\n---\n/,
      '',
    )
    .replace(/\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[^"]+">>>$/, '');
}
function senderAddress(value: unknown): string {
  if (typeof value !== 'string') return '';
  return (
    value.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] ?? value.trim()
  ).toLowerCase();
}
export async function readSchoolEmails(
  config: SchoolEmailConfig,
  sourceGroup: string,
  after: string,
) {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(config.senderDomain))
    throw new Error('Invalid school sender domain');
  const domain = config.senderDomain.toLowerCase();
  const matches = (value: unknown) => {
    const host = senderAddress(value).split('@')[1];
    return !!host && (host === domain || host.endsWith(`.${domain}`));
  };
  const rows = JSON.parse(
    await googleGmailSearch(
      {
        gmail: config.alias,
        query: `from:(${domain}) after:${Math.floor(Date.parse(after) / 1000)}`,
        max: 100,
      },
      sourceGroup,
    ),
  );
  if (!Array.isArray(rows))
    throw new Error('Unexpected school email search result');
  if (rows.length >= 100)
    throw new Error(
      'School email search reached its limit; review backlog before advancing',
    );
  const selected = rows.filter((row) => matches(row.from));
  const results = [];
  // Small batches bound Gmail concurrency and keep prepare latency below the IPC deadline.
  for (let offset = 0; offset < selected.length; offset += 4) {
    const batch = await Promise.all(
      selected.slice(offset, offset + 4).map(async (row) => {
        const full = JSON.parse(
          await googleGmailMessageRead(
            { gmail: config.alias, messageId: row.id },
            sourceGroup,
          ),
        );
        const headers = full.headers ?? full.message?.headers;
        if (!matches(headers?.from)) return null;
        const timestamp = full.message?.internalDate
          ? Number(full.message.internalDate)
          : Date.parse(headers?.date);
        if (!Number.isFinite(timestamp))
          throw new Error('School email has no valid timestamp');
        if (timestamp < Date.parse(after)) return null;
        const subject = content(headers?.subject);
        const body = content(full.body ?? full.message?.body).trim();
        const attachments = (
          Array.isArray(full.message?.attachments)
            ? full.message.attachments
            : []
        )
          .map((attachment: { filename?: unknown }) =>
            content(attachment.filename),
          )
          .filter(Boolean);
        const coverageWarning = body
          ? undefined
          : `Email bez čitljivog teksta: ${subject}${attachments.length ? ` — prilozi: ${attachments.join(', ')}` : ''}. Sadržaj nije protumačen; proverite originalni mejl.`;
        const readableBody =
          body ||
          `[No readable email body. ${attachments.length ? `Attachments: ${attachments.join(', ')}.` : 'No readable attachment metadata.'} Do not infer its contents or treat it as no news.]`;

        return {
          sourceType: 'email' as const,
          gmailAlias: config.alias,
          emailMessageId: row.id,
          chatId: `gmail:${config.alias}`,
          messageId: `gmail:${config.alias}:${row.id}`,
          timestamp: new Date(timestamp).toISOString(),
          fromMe: false,
          senderId: senderAddress(headers.from),
          senderName: headers.from,
          subject,
          coverageWarning,
          text: `Email subject: ${subject}\n\n${readableBody}`,
          media: undefined,
          edited: false,
          revoked: false,
        };
      }),
    );
    results.push(...batch.filter((message) => message !== null));
  }
  return results;
}
