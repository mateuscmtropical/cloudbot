import type { ReactElement } from 'react';

interface PeopleHubHintProps {
    onClose: () => void;
}

// Shown on an instance that is not the owner's instance inside the hub, where people cannot be added.
function PeopleHubHint({ onClose }: PeopleHubHintProps): ReactElement {
    return (
        <section className="people-panel" aria-labelledby="people-title">
            <header className="people-panel-header">
                <div>
                    <h1 id="people-title">People</h1>
                    <p>This CloudBot runs on its own, so it cannot invite people.</p>
                </div>
                <button type="button" className="choice-button" aria-label="Close people panel" onClick={onClose}>Close</button>
            </header>
            <p>
                To give other people their own CloudBot, install CloudBot as a hub. The hub makes a separate CloudBot for each person and signs them in.
                You add people here, in this panel, once the hub runs.
            </p>
            <p>The install steps are in docs/INSTALL.md in the CloudBot repository.</p>
        </section>
    );
}

export { PeopleHubHint };
