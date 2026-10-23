import type { InstanceActivity } from '../../shared/hubProtocol.ts';

interface ActivitySources {
    hasActiveTurn: boolean;
    hasEnabledRoutine: boolean;
    hasEnabledWatch: boolean;
    hasWebhook: boolean;
    hasWhatsAppConnection: boolean;
    hasTelegramConnection: boolean;
    hasEmailAccount: boolean;
    hasAgentProgram: boolean;
    isLoginOrSetupInProgress: boolean;
}

function computeActivity(sources: ActivitySources): InstanceActivity {
    const reasons: string[] = [];

    if (sources.hasActiveTurn) {
        reasons.push('turn running or queued');
    }

    if (sources.hasEnabledRoutine) {
        reasons.push('routine enabled');
    }

    if (sources.hasEnabledWatch) {
        reasons.push('page watch enabled');
    }

    if (sources.hasWebhook) {
        reasons.push('webhook configured');
    }

    if (sources.hasWhatsAppConnection) {
        reasons.push('WhatsApp connected');
    }

    if (sources.hasTelegramConnection) {
        reasons.push('Telegram connected');
    }

    if (sources.hasEmailAccount) {
        reasons.push('email account configured');
    }

    if (sources.hasAgentProgram) {
        reasons.push('program listening on a port');
    }

    if (sources.isLoginOrSetupInProgress) {
        reasons.push('login or setup in progress');
    }

    return { isBusy: reasons.length > 0, reasons };
}

export { computeActivity };
export type { ActivitySources };
