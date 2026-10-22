import { describe, expect, it } from 'vitest';

import { parseEmailSource } from './parseEmail.ts';

describe('parseEmailSource', () => {
    it('reads plain sender, subject, date and text without retaining attachment content', async () => {
        const source = [
            'From: Ana Example <ana@example.com>',
            'To: bot@example.com',
            'Subject: Please review',
            'Date: Thu, 22 Oct 2026 10:00:00 +0000',
            'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="mail-boundary"',
            '',
            '--mail-boundary',
            'Content-Type: text/plain; charset="utf-8"',
            '',
            'The message body.',
            '--mail-boundary',
            'Content-Type: text/plain; name="note.txt"',
            'Content-Disposition: attachment; filename="note.txt"',
            'Content-Transfer-Encoding: base64',
            '',
            'U2VjcmV0IGF0dGFjaG1lbnQgY29udGVudA==',
            '--mail-boundary--',
            '',
        ].join('\r\n');

        const parsed = await parseEmailSource(Buffer.from(source));

        expect(parsed)
            .toEqual({
                sender: 'ana@example.com',
                subject: 'Please review',
                receivedAt: '2026-10-22T10:00:00.000Z',
                text: 'The message body.',
                attachmentCount: 1,
            });
        expect(parsed.text)
            .not.toContain('Secret attachment content');
    });

    it('converts an html-only message into text', async () => {
        const source = ['From: Ana <ana@example.com>', 'Subject: Hello', 'Content-Type: text/html; charset="utf-8"', '', '<p>Hello <b>there</b>.</p>'].join('\r\n');

        const parsed = await parseEmailSource(Buffer.from(source));

        expect(parsed.text)
            .toContain('Hello there.');
    });
});
