import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { SettingsStore } from '../store/SettingsStore.ts';

import { SetupAccess } from './SetupAccess.ts';

describe('SetupAccess', () => {
    let opened: OpenedDatabase;
    let access: SetupAccess;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        access = new SetupAccess(new SettingsStore(opened.db));
    });

    afterEach(() => {
        opened.close();
    });

    it('redeems a valid code into a session that passes the check', async () => {
        const setupCode = await access.issueSetupCode();
        const sessionToken = await access.redeemSetupCode(setupCode);

        await expect(access.isValidSession(sessionToken))
            .resolves.toBe(true);
        await expect(access.hasSession())
            .resolves.toBe(true);
    });

    it('refuses a code that was already redeemed', async () => {
        const setupCode = await access.issueSetupCode();

        await access.redeemSetupCode(setupCode);

        await expect(access.redeemSetupCode(setupCode))
            .resolves.toBeUndefined();
    });

    it('refuses a wrong code', async () => {
        await access.issueSetupCode();

        await expect(access.redeemSetupCode('not-the-code'))
            .resolves.toBeUndefined();
        await expect(access.hasSession())
            .resolves.toBe(false);
    });

    it('treats a missing cookie as no session', async () => {
        await expect(access.isValidSession(undefined))
            .resolves.toBe(false);
    });

    it('ends the session when the code is rotated', async () => {
        const firstCode = await access.issueSetupCode();
        const sessionToken = await access.redeemSetupCode(firstCode);

        await access.issueSetupCode();

        await expect(access.isValidSession(sessionToken))
            .resolves.toBe(false);
    });

    it('stores only hashes, never the raw code or token', async () => {
        const setupCode = await access.issueSetupCode();
        const sessionToken = await access.redeemSetupCode(setupCode);
        const storedRows = opened.sqlite.prepare('SELECT value FROM settings')
            .all();
        const storedValues = storedRows.map(row => String(row.value));

        expect(storedValues)
            .not.toContain(setupCode);
        expect(storedValues)
            .not.toContain(sessionToken);
    });
});
