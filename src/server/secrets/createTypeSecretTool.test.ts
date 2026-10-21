import { describe, expect, it } from 'vitest';

import { BrowserError } from '../desktop/BrowserControl.ts';
import type { BrowserControl } from '../desktop/BrowserControl.ts';
import { createTypeSecretTool } from './createTypeSecretTool.ts';
import type { SecretToolResult } from './createSecretTools.ts';

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<SecretToolResult>;

const SECRET = { site: 'https://github.com', value: 'fake-password-1' };

function createHandler(typeSecret: (site: string, value: string) => Promise<void>): { handler: ToolHandler; typed: string[][] } {
    const typed: string[][] = [];
    const browser = {
        typeSecret: (site: string, value: string) => {
            typed.push([site, value]);

            return typeSecret(site, value);
        },
        takeDismissedDialogs: () => [],
    } as unknown as BrowserControl;
    const typeTool = createTypeSecretTool(browser, name => (name === 'GITHUB_PASSWORD' ? SECRET : undefined));

    return { handler: typeTool.handler as unknown as ToolHandler, typed };
}

describe('createTypeSecretTool', () => {
    it('types the saved value for its site and never returns it', async () => {
        const { handler, typed } = createHandler(() => Promise.resolve());
        const result = await handler({ name: 'GITHUB_PASSWORD' }, {});

        expect(typed)
            .toEqual([['https://github.com', 'fake-password-1']]);
        expect(JSON.stringify(result)).not.toContain('fake-password-1');
        expect(result.isError)
            .toBeUndefined();
    });

    it('says when no secret has that name', async () => {
        const { handler, typed } = createHandler(() => Promise.resolve());
        const result = await handler({ name: 'OTHER' }, {});

        expect(result.content[0]?.text)
            .toContain('Ask the owner for it with request_secret');
        expect(typed)
            .toEqual([]);
    });

    it('passes a refusal from the browser and hides other errors', async () => {
        const refused = await createHandler(() => Promise.reject(new BrowserError('This secret is only for https://github.com')))
            .handler({ name: 'GITHUB_PASSWORD' }, {});
        const failed = await createHandler(() => Promise.reject(new Error('fake-password-1 in a stack trace')))
            .handler({ name: 'GITHUB_PASSWORD' }, {});

        expect(refused)
            .toEqual({ content: [{ type: 'text', text: 'This secret is only for https://github.com' }], isError: true });
        expect(failed)
            .toEqual({ content: [{ type: 'text', text: 'The secret could not be typed.' }], isError: true });
    });
});
