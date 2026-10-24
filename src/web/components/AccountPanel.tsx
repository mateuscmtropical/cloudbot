import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { describePushResult, disablePushNotifications, enablePushNotifications, readPushState } from '../pushClient.ts';
import type { PushEnableResult, PushSwitchState } from '../pushClient.ts';
import { CloseIcon, PeopleIcon } from './icons.tsx';
import { ListGroup } from './ListGroup.tsx';
import { ListRow } from './ListRow.tsx';
import { RoundButton } from './RoundButton.tsx';
import { Switch } from './Switch.tsx';

// The browser steps behind the notification switch. Tests replace them.
interface PushControls {
    readState: () => Promise<PushSwitchState>;
    turnOn: () => Promise<PushEnableResult>;
    turnOff: () => Promise<void>;
}

interface AccountPanelProps {
    onClose: () => void;
    onPeople?: (() => void) | undefined;
    personName?: string | undefined;
    personRole?: string | undefined;
    // Inside the hub the hub keeps the password, the passkeys and the sign-in. A CloudBot on its own has none of them.
    isHub?: boolean;
    pushControls?: PushControls;
}

interface NotificationsSectionProps {
    pushControls?: PushControls | undefined;
    groupLabel?: string | undefined;
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

function NotificationsSection({ pushControls = BROWSER_PUSH_CONTROLS, groupLabel }: NotificationsSectionProps): ReactElement {
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
        <>
            <ListGroup label={groupLabel} ariaLabel="Notifications">
                <ListRow
                    title="Notifications"
                    className="notification-setting-row"
                    trailingControl={<Switch label="Notifications on this device" checked={isOn} disabled={!canChange} onChange={handleChange} />}
                />
            </ListGroup>
            <p className="settings-help-text">{describeSwitchState(state)}</p>
            {problem === '' ? null : <p className="settings-error" role="alert">{problem}</p>}
        </>
    );
}

// The hub keeps the password, the passkeys and the sign-in of each person, so those parts only lead to its pages.
function AccountPanel({ onClose, onPeople, personName, personRole = 'Owner', isHub = true, pushControls = BROWSER_PUSH_CONTROLS }: AccountPanelProps): ReactElement {
    const displayName = personName ?? 'Owner';
    const trimmedName = displayName.trim();
    const nameParts = trimmedName.split(/\s+/);
    const firstNameParts = nameParts.slice(0, 2);
    const initialLetters = firstNameParts.map(part => part[0] ?? '');
    const joinedInitials = initialLetters.join('');
    const initials = joinedInitials.toUpperCase();

    return (
        <section className="people-panel" aria-labelledby="account-title">
            <header className="people-panel-header settings-page-header">
                <RoundButton label="Close account panel" onClick={onClose}><CloseIcon /></RoundButton>
                <div className="settings-page-title">
                    <h1 id="account-title">Account</h1>
                    <p>{isHub ? 'How you sign in to this CloudBot and what it sends you.' : 'What this CloudBot sends you.'}</p>
                </div>
            </header>

            <div className="account-panel-content">
                <ListGroup ariaLabel="Account">
                    <div className="account-person-row">
                        <span className="account-avatar" aria-hidden="true">{initials}</span>
                        <span className="list-row-copy">
                            <span className="list-row-title">{displayName}</span>
                            <span className="list-row-description">{personRole}</span>
                        </span>
                    </div>
                    {isHub
                        ? (
                                <>
                                    <ListRow
                                        title="Password"
                                        description="Change the password you use to sign in."
                                        href="/__hub/password"
                                        ariaLabel="Change password"
                                        chevron
                                    />
                                    <ListRow
                                        title="Passkeys"
                                        description="Sign in with a fingerprint, face scan or security key."
                                        href="/__hub/passkeys"
                                        ariaLabel="Manage passkeys"
                                        chevron
                                    />
                                    {onPeople !== undefined
                                        ? <ListRow title="People" leadingIcon={<PeopleIcon />} onClick={onPeople} chevron />
                                        : null}
                                </>
                            )
                        : null}
                </ListGroup>

                <NotificationsSection pushControls={pushControls} groupLabel="Bot" />

                {isHub
                    ? (
                            <ListGroup>
                                <form method="post" action="/__hub/logout" className="account-sign-out-form" aria-label="Sign out">
                                    <button type="submit" className="account-sign-out-button">Sign out</button>
                                </form>
                            </ListGroup>
                        )
                    : null}
            </div>
        </section>
    );
}

export { AccountPanel, NotificationsSection };
export type { AccountPanelProps, PushControls };
