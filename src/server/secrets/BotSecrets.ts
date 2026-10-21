import { createHash } from 'node:crypto';

import type { Vault } from '../vault/Vault.ts';

interface BotSecret {
    // The origin where the value may be used, such as https://github.com.
    site: string;
    value: string;
}

// The model reads and writes these names, so they stay short and plain.
const BOT_SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;
const BOT_SECRET_NAME_RULE = 'Use capital letters, digits and underscores, starting with a letter. Up to 32 characters.';
const VAULT_PREFIX = 'BOT';
// A bot form with these names could pass for the Claude setup form, so they are refused.
const RESERVED_PREFIXES = ['ANTHROPIC_', 'CLAUDE_'];
const BOT_TAG_LENGTH = 12;

// The message is written for the model, so it can fix the call and try again.
class BotSecretError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BotSecretError';
    }
}

function assertSecretName(name: string): void {
    if (!BOT_SECRET_NAME_PATTERN.test(name)) {
        throw new BotSecretError(`That secret name is not valid. ${BOT_SECRET_NAME_RULE}`);
    }

    if (RESERVED_PREFIXES.some(prefix => name.startsWith(prefix))) {
        throw new BotSecretError('Names that start with ANTHROPIC_ or CLAUDE_ belong to CloudBot. Pick another name.');
    }
}

// Only https origins, so a value never goes to a page over plain http.
function parseSecretSite(rawSite: string): string {
    let parsedUrl: URL;

    try {
        parsedUrl = new URL(rawSite);
    } catch {
        throw new BotSecretError('The site must be a full https address, such as https://github.com.');
    }

    if (parsedUrl.protocol !== 'https:') {
        throw new BotSecretError('The site must use https.');
    }

    return parsedUrl.origin;
}

// The vault takes names in capital letters. A hash of the bot id keeps each bot's secrets apart.
function buildVaultName(botId: string, name: string): string {
    const botHash = createHash('sha256')
        .update(botId)
        .digest('hex');
    const botTag = botHash.slice(0, BOT_TAG_LENGTH)
        .toUpperCase();

    return `${VAULT_PREFIX}_${botTag}_${name}`;
}

function parseStoredSecret(stored: string): BotSecret | undefined {
    let parsed: unknown;

    try {
        parsed = JSON.parse(stored);
    } catch {
        return undefined;
    }

    if (typeof parsed !== 'object' || parsed === null) {
        return undefined;
    }

    const site: unknown = Reflect.get(parsed, 'site');
    const value: unknown = Reflect.get(parsed, 'value');

    return typeof site === 'string' && typeof value === 'string' ? { site, value } : undefined;
}

// Passwords, codes and payment details the bot asked for. Each one is tied to a bot and a site.
class BotSecrets {
    private readonly vault: Vault;

    constructor(vault: Vault) {
        this.vault = vault;
    }

    save(botId: string, name: string, site: string, value: string): void {
        assertSecretName(name);

        const origin = parseSecretSite(site);
        const stored = JSON.stringify({ site: origin, value });
        const vaultName = buildVaultName(botId, name);

        this.vault.set(vaultName, stored);
    }

    read(botId: string, name: string): BotSecret | undefined {
        if (!BOT_SECRET_NAME_PATTERN.test(name)) {
            return undefined;
        }

        const vaultName = buildVaultName(botId, name);
        const stored = this.vault.get(vaultName);

        return stored === undefined ? undefined : parseStoredSecret(stored);
    }
}

export { BOT_SECRET_NAME_PATTERN, BotSecretError, BotSecrets, assertSecretName, buildVaultName, parseSecretSite };
export type { BotSecret };
