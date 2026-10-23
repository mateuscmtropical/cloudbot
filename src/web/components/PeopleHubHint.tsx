import { useState } from 'react';
import type { ReactElement } from 'react';

interface PeopleHubHintProps {
    onClose: () => void;
}

const INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/mateuscmtropical/cloudbot/main/docker/install.sh | sudo bash';
const INSTALL_GUIDE_URL = 'https://github.com/mateuscmtropical/cloudbot/blob/main/docs/INSTALL.md';

// Shown on a CloudBot that is not the owner's inside a hub, where people cannot be added. That is a CloudBot that runs on its own, or a person's CloudBot in a hub.
function PeopleHubHint({ onClose }: PeopleHubHintProps): ReactElement {
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
                    <p>Add and manage people on a CloudBot hub.</p>
                </div>
                <button type="button" className="choice-button" aria-label="Close people panel" onClick={onClose}>Close</button>
            </header>
            <section className="setup-card people-hint-card" aria-label="Who adds people">
                <h2>Only the owner of a hub adds people</h2>
                <p>
                    Each person has their own CloudBot on the hub, with their own bots, memory and sign-ins.
                    If you use someone else's CloudBot, ask its owner to add or remove people.
                </p>
            </section>
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
        </section>
    );
}

export { PeopleHubHint };
