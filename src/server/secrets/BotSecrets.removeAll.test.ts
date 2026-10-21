import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Vault } from '../vault/Vault.ts';
import { BotSecrets } from './BotSecrets.ts';

describe('BotSecrets.removeAll', () => {
    let folderPath: string;
    let secrets: BotSecrets;

    beforeEach(() => {
        folderPath = mkdtempSync(join(tmpdir(), 'cloudbot-bot-secrets-'));
        secrets = new BotSecrets(new Vault(folderPath));
    });

    afterEach(() => {
        rmSync(folderPath, { recursive: true, force: true });
    });

    it('removes every secret of one bot and keeps the secrets of the others', () => {
        secrets.save('bot-1', 'GITHUB_TOKEN', 'https://github.com', 'first-token');
        secrets.save('bot-1', 'OTHER_KEY', 'https://example.com', 'first-key');
        secrets.save('bot-2', 'GITHUB_TOKEN', 'https://github.com', 'second-token');

        secrets.removeAll('bot-1');

        expect(secrets.read('bot-1', 'GITHUB_TOKEN'))
            .toBeUndefined();
        expect(secrets.read('bot-1', 'OTHER_KEY'))
            .toBeUndefined();
        expect(secrets.read('bot-2', 'GITHUB_TOKEN')?.value)
            .toBe('second-token');
    });
});
