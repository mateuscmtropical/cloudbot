import { describe, expect, it } from 'vitest';

import { BrowserError } from '../desktop/BrowserControl.ts';
import { ScreenHolder } from '../desktop/ScreenHolder.ts';
import type { SecretToolResult } from '../secrets/createSecretTools.ts';
import { BitwardenError } from './BitwardenCli.ts';
import type { BitwardenField, BitwardenLoginItem } from './BitwardenCli.ts';
import { createFillLoginTool } from './createFillLoginTool.ts';
import type { LoginBrowser, LoginVault } from './createFillLoginTool.ts';

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<SecretToolResult>;

const GITHUB: BitwardenLoginItem = { id: 'id-github', name: 'GitHub', uris: ['https://github.com/login'], hasTotp: true };
const GITHUB_WORK: BitwardenLoginItem = { id: 'id-work', name: 'GitHub work', uris: ['github.com'], hasTotp: false };
const EVIL: BitwardenLoginItem = { id: 'id-evil', name: 'Evil', uris: ['https://github.com.evil.com'], hasTotp: false };
const VALUES: Record<BitwardenField, string> = { username: 'ana@example.com', password: 'fake-password-1', totp: '123456' };

interface Harness {
    handler: ToolHandler;
    typed: { origin: string; field: string; value: string }[];
    asked: { summary: string; detail: string | undefined }[];
    fetched: string[];
}

interface HarnessOptions {
    logins?: BitwardenLoginItem[];
    origin?: string;
    isConfigured?: boolean;
    answers?: boolean[];
    screen?: ScreenHolder;
    typeLogin?: () => Promise<void>;
    getValue?: () => Promise<string>;
    listLogins?: () => Promise<BitwardenLoginItem[]>;
}

function createHarness(options: HarnessOptions = {}): Harness {
    const typed: Harness['typed'] = [];
    const asked: Harness['asked'] = [];
    const fetched: string[] = [];
    const approvals = new Set<string>();
    const answers = [...(options.answers ?? [true])];
    const browser: LoginBrowser = {
        readPageOrigin: () => Promise.resolve(options.origin ?? 'https://github.com'),
        typeLogin: (origin, field, value) => {
            typed.push({ origin, field, value });

            return options.typeLogin === undefined ? Promise.resolve() : options.typeLogin();
        },
        takeDismissedDialogs: () => [],
    };
    const vault: LoginVault = {
        isConfigured: () => options.isConfigured ?? true,
        listLogins: () => (options.listLogins === undefined ? Promise.resolve(options.logins ?? [GITHUB]) : options.listLogins()),
        getValue: (_botId, itemId, field) => {
            fetched.push(`${itemId}:${field}`);

            return options.getValue === undefined ? Promise.resolve(VALUES[field]) : options.getValue();
        },
        hasApproval: (botId, itemId, origin) => approvals.has(`${botId}|${itemId}|${origin}`),
        rememberApproval: (botId, itemId, origin) => {
            approvals.add(`${botId}|${itemId}|${origin}`);
        },
    };
    const askOwner = (summary: string, detail: string | undefined): Promise<boolean> => {
        asked.push({ summary, detail });

        return Promise.resolve(answers.shift() ?? false);
    };
    const fillTool = createFillLoginTool({ botId: 'bot-1', browser, vault, askOwner, screen: options.screen });

    return { handler: fillTool.handler as unknown as ToolHandler, typed, asked, fetched };
}

describe('createFillLoginTool', () => {
    it('tells the model to ask the owner when Bitwarden is not connected', async () => {
        const { handler, typed } = createHarness({ isConfigured: false });
        const result = await handler({ field: 'password' }, {});

        expect(result.isError)
            .toBe(true);
        expect(result.content[0]?.text)
            .toBe('Bitwarden is not connected. Ask the owner to connect Bitwarden in Connect apps.');
        expect(typed)
            .toEqual([]);
    });

    it('says so when no login matches the page that is really open', async () => {
        const { handler, typed, asked } = createHarness({ logins: [GITHUB], origin: 'https://example.com' });
        const result = await handler({ field: 'password' }, {});

        expect(result.isError)
            .toBe(true);
        expect(result.content[0]?.text)
            .toBe('The Bitwarden vault has no login for https://example.com.');
        expect(typed)
            .toEqual([]);
        expect(asked)
            .toEqual([]);
    });

    it('does not match look-alike sites or an http page', async () => {
        const lookAlike = await createHarness({ logins: [GITHUB, GITHUB_WORK], origin: 'https://github.com.evil.com' })
            .handler({ field: 'password' }, {});
        const plain = await createHarness({ logins: [GITHUB], origin: 'http://github.com' })
            .handler({ field: 'password' }, {});
        const evilItem = await createHarness({ logins: [EVIL], origin: 'https://github.com' })
            .handler({ field: 'password' }, {});

        expect(lookAlike.isError)
            .toBe(true);
        expect(plain.content[0]?.text)
            .toBe('A login is filled only on an https page.');
        expect(evilItem.content[0]?.text)
            .toContain('has no login for https://github.com');
    });

    it('returns only the names when several logins match and none is chosen', async () => {
        const { handler, typed, asked, fetched } = createHarness({
            logins: [{ ...GITHUB, uris: ['https://github.com'] }, GITHUB_WORK],
        });
        const result = await handler({ field: 'password' }, {});
        const text = result.content[0]?.text ?? '';

        expect(result.isError)
            .toBe(true);
        expect(text)
            .toContain('\'GitHub\', \'GitHub work\'');
        expect(text).not.toContain('id-github');
        expect(text).not.toContain('ana@example.com');
        expect(text).not.toContain('github.com/login');
        expect(typed)
            .toEqual([]);
        expect(asked)
            .toEqual([]);
        expect(fetched)
            .toEqual([]);
    });

    it('picks the login named by item, ignoring case', async () => {
        const { handler, typed } = createHarness({ logins: [GITHUB, GITHUB_WORK] });
        const result = await handler({ field: 'password', item: 'github WORK' }, {});

        expect(result.content[0]?.text)
            .toBe('Typed the password of \'GitHub work\'.');
        expect(typed)
            .toEqual([{ origin: 'https://github.com', field: 'password', value: 'fake-password-1' }]);
    });

    it('lists the names again when item matches no login', async () => {
        const { handler, typed } = createHarness({ logins: [GITHUB, GITHUB_WORK] });
        const result = await handler({ field: 'password', item: 'Gitlab' }, {});

        expect(result.isError)
            .toBe(true);
        expect(result.content[0]?.text)
            .toContain('\'GitHub\', \'GitHub work\'');
        expect(typed)
            .toEqual([]);
    });

    it('asks the owner with the field, the login and the real origin, then types and never returns the value', async () => {
        const { handler, typed, asked } = createHarness();
        const result = await handler({ field: 'password' }, {});

        expect(asked)
            .toHaveLength(1);
        expect(asked[0]?.summary)
            .toBe('Fill the password of \'GitHub\' on https://github.com?');
        expect(asked[0]?.detail)
            .toContain('10 minutes');
        expect(typed)
            .toEqual([{ origin: 'https://github.com', field: 'password', value: 'fake-password-1' }]);
        expect(result.content[0]?.text)
            .toBe('Typed the password of \'GitHub\'.');
        expect(JSON.stringify(result)).not.toContain('fake-password-1');
        expect(result.isError)
            .toBeUndefined();
    });

    it('asks once for the user name, the password and the code of the same login and site', async () => {
        const { handler, typed, asked } = createHarness();

        await handler({ field: 'username' }, {});
        await handler({ field: 'password' }, {});
        const code = await handler({ field: 'totp' }, {});

        expect(asked)
            .toHaveLength(1);
        expect(typed.map(entry => entry.field))
            .toEqual(['username', 'password', 'totp']);
        expect(code.content[0]?.text)
            .toBe('Typed the one-time code of \'GitHub\'.');
        expect(JSON.stringify(code)).not.toContain('123456');
    });

    it('asks again for another login or another site', async () => {
        const { handler, asked } = createHarness({ logins: [GITHUB, GITHUB_WORK], answers: [true, true] });

        await handler({ field: 'password', item: 'GitHub' }, {});
        await handler({ field: 'password', item: 'GitHub work' }, {});

        expect(asked)
            .toHaveLength(2);

        const otherSite = createHarness({ logins: [GITHUB], origin: 'https://gist.github.com', answers: [true] });

        await otherSite.handler({ field: 'password' }, {});

        expect(otherSite.asked[0]?.summary)
            .toContain('on https://gist.github.com?');
    });

    it('does not fetch or type anything when the owner denies, and does not cache the denial', async () => {
        const { handler, typed, asked, fetched } = createHarness({ answers: [false, true] });
        const denied = await handler({ field: 'password' }, {});

        expect(denied.isError)
            .toBe(true);
        expect(denied.content[0]?.text)
            .toContain('did not approve');
        expect(typed)
            .toEqual([]);
        expect(fetched)
            .toEqual([]);

        const approved = await handler({ field: 'password' }, {});

        expect(asked)
            .toHaveLength(2);
        expect(approved.isError)
            .toBeUndefined();
    });

    it('refuses a one-time code for a login that has none', async () => {
        const { handler, asked } = createHarness({ logins: [GITHUB_WORK] });
        const result = await handler({ field: 'totp' }, {});

        expect(result.isError)
            .toBe(true);
        expect(result.content[0]?.text)
            .toContain('has no one-time code');
        expect(asked)
            .toEqual([]);
    });

    it('does nothing while the owner holds the screen', async () => {
        const screen = new ScreenHolder();

        screen.giveToPerson();

        const { handler, typed, asked } = createHarness({ screen });
        const result = await handler({ field: 'password' }, {});

        expect(result.isError)
            .toBe(true);
        expect(typed)
            .toEqual([]);
        expect(asked)
            .toEqual([]);
    });

    it('passes a refusal of the browser or of Bitwarden and hides every other error', async () => {
        const refusedByBrowser = await createHarness({ typeLogin: () => Promise.reject(new BrowserError('The focused field is not a password field. Click that field first.')) })
            .handler({ field: 'password' }, {});
        const refusedByBitwarden = await createHarness({ getValue: () => Promise.reject(new BitwardenError('That login has no password.')) })
            .handler({ field: 'password' }, {});
        const unknown = await createHarness({ getValue: () => Promise.reject(new Error('fake-password-1 in a stack trace')) })
            .handler({ field: 'password' }, {});

        expect(refusedByBrowser.content[0]?.text)
            .toBe('The focused field is not a password field. Click that field first.');
        expect(refusedByBitwarden.content[0]?.text)
            .toBe('That login has no password.');
        expect(unknown)
            .toEqual({ content: [{ type: 'text', text: 'The login could not be filled.' }], isError: true });
    });

    it('cleans a login name that came from the vault before it is shown', async () => {
        const messy: BitwardenLoginItem = { ...GITHUB, name: `Git\nHub${'x'.repeat(200)}` };
        const { handler, asked } = createHarness({ logins: [messy] });
        const result = await handler({ field: 'password' }, {});

        expect(asked[0]?.summary).not.toContain('\n');
        expect((result.content[0]?.text ?? '').length)
            .toBeLessThan(150);
    });
});
