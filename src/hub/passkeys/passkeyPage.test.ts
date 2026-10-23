import { describe, expect, it } from 'vitest';

import type { HubPasskeyStore } from './HubPasskeyStore.ts';
import { createAfterLogin, passkeyLoginExtras, PASSKEY_OFFER_PATH, renderOfferPage, renderPasskeysPage, shouldOfferPasskey } from './passkeyPage.ts';

describe('passkeyPage', () => {
    it('hides passkey sign-in until a platform authenticator is available', () => {
        const extras = passkeyLoginExtras();

        expect(extras.html)
            .toContain('id="hub-passkey-login-block" class="stack" hidden>');
        expect(extras.script)
            .toContain('isUserVerifyingPlatformAuthenticatorAvailable');
        expect(extras.script)
            .toContain('/__hub/passkey/login/options');
        expect(extras.script)
            .toContain('/__hub/passkey/login/verify');
    });

    it('offers enrollment and skips itself when the browser has no platform authenticator', () => {
        const page = renderOfferPage();

        expect(page.body)
            .toContain('Turn on fingerprint or face for this device?');
        expect(page.body)
            .toContain('Not now');
        expect(page.script)
            .toContain('isUserVerifyingPlatformAuthenticatorAvailable');
        expect(page.script)
            .toContain('window.location.replace("/")');
        expect(page.script)
            .toContain('Max-Age=15552000');
        expect(page.script)
            .toContain('/__hub/passkey/register/verify');
    });

    it('offers enrollment only when the person has no passkeys and has not skipped', () => {
        const withoutPasskeys: Pick<HubPasskeyStore, 'list'> = { list: () => [] };
        const withPasskeys: Pick<HubPasskeyStore, 'list'> = {
            list: () => [{
                personName: 'maria',
                credentialId: 'credential-1',
                publicKey: 'AQID',
                counter: 0,
                transports: [],
                label: 'Phone',
                createdAt: 1,
            }],
        };

        expect(shouldOfferPasskey('maria', withoutPasskeys, undefined))
            .toBe(true);
        expect(shouldOfferPasskey('maria', withoutPasskeys, 'skip'))
            .toBe(false);
        expect(shouldOfferPasskey('maria', withPasskeys, undefined))
            .toBe(false);
    });

    it('returns the offer path through the front door after-login hook', () => {
        const store: Pick<HubPasskeyStore, 'list'> = { list: () => [] };
        const context = null as unknown as Parameters<ReturnType<typeof createAfterLogin>>[1];
        const afterLogin = createAfterLogin({ store, cookiesOf: (_name, currentContext) => currentContext === context ? undefined : 'skip' });

        expect(afterLogin('maria', context))
            .toBe(PASSKEY_OFFER_PATH);
        expect(createAfterLogin({ store, cookiesOf: () => 'skip' })('maria', context))
            .toBeUndefined();
    });

    it('renders passkeys with escaped labels and a removal action', () => {
        const page = renderPasskeysPage([{
            id: 'credential-1',
            label: '<Phone>',
            createdAt: 1,
        }]);

        expect(page.body)
            .toContain('&lt;Phone&gt;');
        expect(page.body)
            .toContain('aria-label="Remove &lt;Phone&gt;"');
        expect(page.script)
            .toContain('method: "DELETE"');
    });
});
