import { useState } from 'react';
import type { ReactElement } from 'react';

import type { HubRole } from '../peopleClient.ts';

interface PeopleHubHintProps {
    role: Exclude<HubRole, 'owner'>;
    onClose: () => void;
    onAccount?: (() => void) | undefined;
}

const INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/mateuscmtropical/cloudbot/main/docker/install.sh | sudo bash';
const INSTALL_GUIDE_URL = 'https://github.com/mateuscmtropical/cloudbot/blob/main/docs/INSTALL.md';

// Shown where people cannot be added: on a CloudBot that runs on its own, and on a person's CloudBot inside a hub.
function PeopleHubHint({ role, onClose, onAccount }: PeopleHubHintProps): ReactElement {
    const isMember = role === 'member';
    const [isCopied, setIsCopied] = useState(false);
    const [copyProblem, setCopyProblem] = useState<string | undefined>(undefined);

    async function copyCommand(): Promise<void> {
        try {
            await navigator.clipboard.writeText(INSTALL_COMMAND);
            setIsCopied(true);
            setCopyProblem(undefined);
        } catch {
            setIsCopied(false);
            setCopyProblem('Could not copy to the clipboard.');
        }
    }

    return (
        <section className="people-panel" aria-labelledby="people-title">
            <header className="people-panel-header">
                <div>
                    <h1 id="people-title">People</h1>
                    <p>{isMember ? 'You are a person on a CloudBot hub.' : 'Give other people their own CloudBot.'}</p>
                </div>
                <div className="people-panel-actions">
                    {onAccount === undefined ? null : <button type="button" className="choice-button" onClick={onAccount}>Account</button>}
                    <button type="button" className="choice-button" aria-label="Close people panel" onClick={onClose}>Close</button>
                </div>
            </header>
            <section className="setup-card people-hint-card" aria-label="Who adds people">
                {isMember
                    ? (
                            <>
                                <h2>Only the owner of the hub adds people</h2>
                                <p>Ask the owner of this hub to add or remove people. You manage your own bots, memory and sign-ins here.</p>
                            </>
                        )
                    : (
                            <>
                                <h2>This CloudBot runs on its own</h2>
                                <p>You are its owner. People need a hub, which gives each person their own CloudBot with their own bots, memory and sign-ins.</p>
                            </>
                        )}
            </section>
            {isMember
                ? null
                : (
                        <section className="setup-card people-hint-card" aria-label="Run your own hub">
                            <h2>Run your own hub</h2>
                            <p>Run this on a Debian or Ubuntu server. The hub makes a separate CloudBot for each person and signs them in. You add people here once it runs.</p>
                            <div className="people-credential-row">
                                <code>{INSTALL_COMMAND}</code>
                                <button type="button" className="choice-button" onClick={() => { void copyCommand(); }}>{isCopied ? 'Copied' : 'Copy command'}</button>
                            </div>
                            {copyProblem === undefined ? null : <p className="people-problem" role="alert">{copyProblem}</p>}
                            <p>
                                <a href={INSTALL_GUIDE_URL} target="_blank" rel="noreferrer">Read the install guide</a>
                            </p>
                        </section>
                    )}
        </section>
    );
}

export { PeopleHubHint };
