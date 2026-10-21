import { describe, expect, it } from 'vitest';

import { BotSecretError } from './BotSecrets.ts';
import { createRequestSecretTool } from './createSecretTools.ts';
import type { SecretToolResult } from './createSecretTools.ts';

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<SecretToolResult>;

describe('createRequestSecretTool', () => {
    it('posts the form and says the value stays hidden', async () => {
        const requests: string[][] = [];
        const requestTool = createRequestSecretTool((name, purpose, site) => {
            requests.push([name, purpose, site]);

            return Promise.resolve({ site: 'https://github.com' });
        });
        const handler = requestTool.handler as unknown as ToolHandler;
        const result = await handler({ name: 'GITHUB_PASSWORD', purpose: 'Sign in to GitHub', site: 'https://github.com/login' }, {});

        expect(requests)
            .toEqual([['GITHUB_PASSWORD', 'Sign in to GitHub', 'https://github.com/login']]);
        expect(result.content[0]?.text)
            .toContain('You will not see the value.');
        expect(result.isError)
            .toBeUndefined();
    });

    it('returns a BotSecretError as a tool error and hides other errors', async () => {
        const refusing = createRequestSecretTool(() => Promise.reject(new BotSecretError('The site must use https.')));
        const failing = createRequestSecretTool(() => Promise.reject(new Error('/var/lib/cloudbot/vault.json')));
        const refused = await (refusing.handler as unknown as ToolHandler)({ name: 'A', purpose: 'p', site: 'http://x' }, {});
        const failed = await (failing.handler as unknown as ToolHandler)({ name: 'A', purpose: 'p', site: 'https://x' }, {});

        expect(refused)
            .toEqual({ content: [{ type: 'text', text: 'The site must use https.' }], isError: true });
        expect(failed)
            .toEqual({ content: [{ type: 'text', text: 'The secure form could not be posted.' }], isError: true });
    });
});
