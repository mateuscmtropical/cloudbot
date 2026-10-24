import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { describePushResult, disablePushNotifications, enablePushNotifications, readPushState } from '../pushClient.ts';
import type { PushEnableResult, PushSwitchState } from '../pushClient.ts';

// The browser steps behind the notification switch. Tests replace them.
interface PushControls {
    readState: () => Promise<PushSwitchState>;
    turnOn: () => Promise<PushEnableResult>;
    turnOff: () => Promise<void>;
}

interface AccountPanelProps {
    onClose: () => void;
    // Inside the hub the hub keeps the password, the passkeys and the sign-in. A CloudBot on its own has none of them.
    isHub?: boolean;
    pushControls?: PushControls;
}

interface NotificationsSectionProps {
    pushControls: PushControls;
}

type SwitchState = PushSwitchState | 'loading';

const BROWSER_PUSH_CONTROLS: PushControls = {
    readState: () => readPushState(),
    turnOn: () => enablePushNotifications(),
    turnOff: () => disablePushNotifications(),
};
const NOTIFICATIONS_TEXT = 'Get a notification on this device when a bot finishes or needs you while CloudBot is not on screen.';
const SWITCH_FAILED_TEXT = 'Could not change notifications. Try again.';

function describeSwitchState(state: SwitchState): string {
    if (state === 'blocked' || state === 'unsupported') {
        return describePushResult(state);
    }

    return NOTIFICATIONS_TEXT;
}

function NotificationsSection({ pushControls }: NotificationsSectionProps): ReactElement {
    const [state, setState] = useState<SwitchState>('loading');
    const [isBusy, setIsBusy] = useState(false);
    const [problem, setProblem] = useState('');

    useEffect(() => {
        let isCurrent = true;

        pushControls.readState()
            .then((current) => {
                if (isCurrent) {
                    setState(current);
                }
            })
            .catch(() => {
                if (isCurrent) {
                    setState('off');
                }
            });

        return () => {
            isCurrent = false;
        };
    }, [pushControls]);

    const isOn = state === 'on';
    const canChange = !isBusy && (state === 'on' || state === 'off');

    // turnOn asks for permission first, so it is called straight from the tap. A browser shows its prompt only then.
    const handleChange = (): void => {
        setIsBusy(true);
        setProblem('');
        const change = isOn
            ? pushControls.turnOff()
                    .then((): SwitchState => 'off')
            : pushControls.turnOn()
                    .then((result): SwitchState => (result === 'enabled' ? 'on' : result));

        change
            .then((nextState) => {
                setState(nextState);
            })
            .catch(() => {
                setProblem(SWITCH_FAILED_TEXT);
            })
            .finally(() => {
                setIsBusy(false);
            });
    };

    return (
        <section className="setup-card people-hint-card" aria-label="Notifications">
            <h2>Notifications</h2>
            <p>{describeSwitchState(state)}</p>
            <label className="switch-row">
                <input type="checkbox" role="switch" checked={isOn} disabled={!canChange} onChange={handleChange} />
                <span>Notifications on this device</span>
            </label>
            {problem === '' ? null : <p role="alert">{problem}</p>}
        </section>
    );
}

// The hub keeps the password, the passkeys and the sign-in of each person, so those parts only lead to its pages.
function AccountPanel({ onClose, isHub = true, pushControls = BROWSER_PUSH_CONTROLS }: AccountPanelProps): ReactElement {
    return (
        <section className="people-panel" aria-labelledby="account-title">
            <header className="people-panel-header">
                <div>
                    <h1 id="account-title">Account</h1>
                    <p>{isHub ? 'How you sign in to this CloudBot and what it sends you.' : 'What this CloudBot sends you.'}</p>
                </div>
                <button type="button" className="choice-button" aria-label="Close account panel" onClick={onClose}>Close</button>
            </header>
            <NotificationsSection pushControls={pushControls} />
            {isHub
                ? (
                        <>
                            <section className="setup-card people-hint-card" aria-label="Password">
                                <h2>Password</h2>
                                <p>Change the password you use to sign in. This signs you out on your other devices.</p>
                                <p>
                                    <a className="choice-button" href="/__hub/password">Change password</a>
                                </p>
                            </section>
                            <section className="setup-card people-hint-card" aria-label="Passkeys">
                                <h2>Passkeys</h2>
                                <p>Sign in with a fingerprint, a face scan or a security key instead of the password. Add or remove the passkeys of your devices.</p>
                                <p>
                                    <a className="choice-button" href="/__hub/passkeys">Manage passkeys</a>
                                </p>
                            </section>
                            <section className="setup-card people-hint-card" aria-label="Sign out">
                                <h2>Sign out</h2>
                                <p>Sign out of this CloudBot on this device.</p>
                                <form method="post" action="/__hub/logout">
                                    <button type="submit" className="choice-button">Sign out</button>
                                </form>
                            </section>
                        </>
                    )
                : null}
        </section>
    );
}

export { AccountPanel };
export type { AccountPanelProps, PushControls };
