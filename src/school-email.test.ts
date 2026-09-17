import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./google-workspace.js', () => ({
  googleGmailSearch: vi.fn(),
  googleGmailMessageRead: vi.fn(),
}));
import {
  googleGmailSearch,
  googleGmailMessageRead,
} from './google-workspace.js';
import { readSchoolEmails } from './school-email.js';
const config = { alias: 'school_mail', senderDomain: 'edu.pt' };
const wrap = (text: string, id: string) =>
  `<<<EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>\nSource: google_api\n---\n${text}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>`;
beforeEach(() => vi.resetAllMocks());
describe('school email source', () => {
  it('uses the authorized mailbox and checks actual sender domains, not display names', async () => {
    vi.mocked(googleGmailSearch).mockResolvedValue(
      JSON.stringify([
        { id: 'a', from: 'Teacher <teacher@school.edu.pt>' },
        { id: 'b', from: '"edu.pt" <sender@unrelated.com>' },
        { id: 'c', from: 'sender@school.edu.pt.evil.com' },
      ]),
    );
    vi.mocked(googleGmailMessageRead).mockResolvedValue(
      JSON.stringify({
        headers: {
          from: 'Teacher <teacher@school.edu.pt>',
          subject: wrap('School kit', 'a'),
        },
        message: { internalDate: Date.parse('2026-09-17T14:38:16Z') },
        body: wrap('Optional lunchbox suggestion.', 'b'),
      }),
    );
    const rows = await readSchoolEmails(
      config,
      'telegram_main',
      '2026-09-16T00:00:00Z',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceType: 'email',
      messageId: 'gmail:school_mail:a',
      senderId: 'teacher@school.edu.pt',
      text: 'Email subject: School kit\n\nOptional lunchbox suggestion.',
    });
    expect(googleGmailSearch).toHaveBeenCalledWith(
      expect.objectContaining({ gmail: 'school_mail' }),
      'telegram_main',
    );
    expect(googleGmailMessageRead).toHaveBeenCalledExactlyOnceWith(
      { gmail: 'school_mail', messageId: 'a' },
      'telegram_main',
    );
  });
  it('keeps repeated reads stable despite changing untrusted wrapper IDs', async () => {
    vi.mocked(googleGmailSearch).mockResolvedValue(
      JSON.stringify([{ id: 'a', from: 'a@edu.pt' }]),
    );
    for (const id of ['one', 'two'])
      vi.mocked(googleGmailMessageRead).mockResolvedValueOnce(
        JSON.stringify({
          headers: {
            from: 'a@edu.pt',
            subject: wrap('Title', id),
            date: 'Thu, 17 Sep 2026 14:38:16 +0000',
          },
          body: wrap('Text', id),
        }),
      );
    expect(
      await readSchoolEmails(config, 'main', '2026-09-16T00:00:00Z'),
    ).toEqual(await readSchoolEmails(config, 'main', '2026-09-16T00:00:00Z'));
  });
  it('fails rather than reporting no updates when the body is unavailable or search is capped', async () => {
    vi.mocked(googleGmailSearch).mockResolvedValue(
      JSON.stringify([{ id: 'a', from: 'a@edu.pt' }]),
    );
    vi.mocked(googleGmailMessageRead).mockResolvedValue(
      JSON.stringify({
        headers: { from: 'a@edu.pt', date: 'Thu, 17 Sep 2026 14:38:16 +0000' },
      }),
    );
    await expect(
      readSchoolEmails(config, 'main', '2026-09-16T00:00:00Z'),
    ).rejects.toThrow('body unavailable');
    vi.mocked(googleGmailSearch).mockResolvedValue(
      JSON.stringify(Array(100).fill({ id: 'a' })),
    );
    await expect(
      readSchoolEmails(config, 'main', '2026-09-16T00:00:00Z'),
    ).rejects.toThrow('limit');
  });
});
