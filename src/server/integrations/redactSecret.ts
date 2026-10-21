const REDACTED = '[redacted]';

interface SecretForms {
    // Forms that are replaced in full.
    whole: string[];
    // Forms a cut output can end with part of. A partial match at the end of a truncated output is dropped.
    prefixes: string[];
}

interface Base64Alignment {
    // Base64 of the groups that lie fully inside the secret, for one position of the secret in the stream.
    complete: string;
    // Base64 of the whole aligned part, without padding. Its start matches the stream where the output was cut.
    full: string;
}

// The secret can sit at any of the three positions inside a base64 group. Each position gives its own characters.
function base64Alignments(bytes: Buffer): Base64Alignment[] {
    return [0, 1, 2].map((startInGroup) => {
        const body = bytes.subarray((3 - startInGroup) % 3);
        const completeLength = body.length - (body.length % 3);

        return {
            complete: body.subarray(0, completeLength)
                .toString('base64'),
            full: body.toString('base64')
                .replace(/=+$/, ''),
        };
    });
}

function toUrlSafeBase64(text: string): string {
    return text.replace(/\+/g, '-')
        .replace(/\//g, '_');
}

// The forms the secret can take in output: the value, hex, URL-encoded, and base64 and base64url at each alignment.
function secretForms(secret: string): SecretForms {
    const bytes = Buffer.from(secret, 'utf8');
    const hex = bytes.toString('hex');
    const alignments = base64Alignments(bytes);
    const completes = alignments.map(alignment => alignment.complete)
        .filter(complete => complete !== '');
    const fulls = alignments.map(alignment => alignment.full);
    const whole = [
        secret,
        hex,
        hex.toUpperCase(),
        encodeURIComponent(secret),
        ...completes,
        ...completes.map(toUrlSafeBase64),
    ];
    const prefixes = [
        ...whole,
        ...fulls,
        ...fulls.map(toUrlSafeBase64),
    ];

    return { whole, prefixes };
}

// The longest end of the text that starts a prefix of the form, so it could be the start of a secret cut in two.
function longestTailMatch(text: string, prefix: string): number {
    const maxLength = Math.min(prefix.length - 1, text.length);
    const lengths = Array.from({ length: maxLength }, (_, index) => index + 1);

    const matching = lengths.filter((length) => {
        const head = prefix.slice(0, length);

        return text.endsWith(head);
    });

    return matching.reduce((longest, length) => Math.max(longest, length), 0);
}

function dropPartialTail(text: string, prefixes: string[]): string {
    const cut = prefixes
        .map(prefix => longestTailMatch(text, prefix))
        .reduce((longest, length) => Math.max(longest, length), 0);

    return text.slice(0, text.length - cut);
}

// Replaces the secret in the text, in every form it can take. Use it on the whole captured output, before any cut.
// When the output was cut at the byte limit, a secret that the cut split is removed from the end too.
function redactSecret(text: string, secret: string | undefined, truncated = false): string {
    if (secret === undefined || secret === '') {
        return text;
    }

    const forms = secretForms(secret);
    const longestFirst = [...forms.whole].sort((first, second) => second.length - first.length);
    const replaced = longestFirst.reduce((current, form) => current.split(form)
        .join(REDACTED), text);

    return truncated ? dropPartialTail(replaced, forms.prefixes) : replaced;
}

export { redactSecret };
