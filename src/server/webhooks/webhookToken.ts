import { createHash, randomBytes } from 'node:crypto';

// 32 random bytes, so the token cannot be guessed. The URL path carries it as base64url text.
function createWebhookToken(): string {
    return randomBytes(32)
        .toString('base64url');
}

function hashWebhookToken(token: string): string {
    return createHash('sha256')
        .update(token)
        .digest('hex');
}

function buildWebhookUrl(baseUrl: string, token: string): string {
    return `${baseUrl}/hooks/${token}`;
}

export { buildWebhookUrl, createWebhookToken, hashWebhookToken };
