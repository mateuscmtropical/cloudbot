import { describe, expect, it } from 'vitest';

import { computeActivity } from './activity.ts';
import type { ActivitySources } from './activity.ts';

const idleSources: ActivitySources = {
    hasActiveTurn: false,
    hasEnabledRoutine: false,
    hasEnabledWatch: false,
    hasWebhook: false,
    hasWhatsAppConnection: false,
    hasTelegramConnection: false,
    hasEmailAccount: false,
    hasAgentProgram: false,
    isLoginOrSetupInProgress: false,
};

describe('computeActivity', () => {
    it('lists a pending app sign-in as a reason to stay awake', () => {
        expect(computeActivity({ ...idleSources, hasAppSignIn: true }))
            .toEqual({ isBusy: true, reasons: ['app sign-in in progress'] });
    });

    it('reports no busy reasons when every source is idle', () => {
        expect(computeActivity(idleSources))
            .toEqual({ isBusy: false, reasons: [] });
    });

    it('reports a short reason for each active source', () => {
        const sources: ActivitySources = {
            hasActiveTurn: true,
            hasEnabledRoutine: true,
            hasEnabledWatch: true,
            hasWebhook: true,
            hasWhatsAppConnection: true,
            hasTelegramConnection: true,
            hasEmailAccount: true,
            hasAgentProgram: true,
            isLoginOrSetupInProgress: true,
        };

        expect(computeActivity(sources))
            .toEqual({
                isBusy: true,
                reasons: [
                    'turn running or queued',
                    'routine enabled',
                    'page watch enabled',
                    'webhook configured',
                    'WhatsApp connected',
                    'Telegram connected',
                    'email account configured',
                    'program listening on a port',
                    'login or setup in progress',
                ],
            });
    });

    it('counts an enabled once routine even when it has not run', () => {
        const sources: ActivitySources = { ...idleSources, hasEnabledRoutine: true };

        expect(computeActivity(sources))
            .toEqual({ isBusy: true, reasons: ['routine enabled'] });
    });
});
