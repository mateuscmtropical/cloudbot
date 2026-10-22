import { simpleParser } from 'mailparser';

// HTML is converted to text, so a mail with only an HTML part still has a body. The source itself is
// capped before it reaches this function, and this cap keeps the conversion of a large part bounded.
const MAX_HTML_LENGTH_TO_PARSE = 500000;

interface ParsedEmail {
    sender: string;
    subject: string;
    receivedAt: string | undefined;
    text: string;
    attachmentCount: number;
}

function formatReceivedAt(date: Date | undefined): string | undefined {
    if (date === undefined) {
        return undefined;
    }

    const timestamp = date.getTime();

    if (Number.isNaN(timestamp)) {
        return undefined;
    }

    return date.toISOString();
}

// Attachments are counted but never kept. The text is the plain part, or the text mailparser makes from HTML.
async function parseEmailSource(source: Buffer | string): Promise<ParsedEmail> {
    const parsed = await simpleParser(source, {
        maxHtmlLengthToParse: MAX_HTML_LENGTH_TO_PARSE,
        skipImageLinks: true,
        skipTextToHtml: true,
    });
    const firstSender = parsed.from?.value[0];
    const sender = firstSender?.address ?? parsed.from?.text ?? '';
    const subject = parsed.subject ?? '';
    const receivedAt = formatReceivedAt(parsed.date);

    return {
        sender,
        subject,
        receivedAt,
        text: parsed.text ?? '',
        attachmentCount: parsed.attachments.length,
    };
}

export { MAX_HTML_LENGTH_TO_PARSE, parseEmailSource };
export type { ParsedEmail };
