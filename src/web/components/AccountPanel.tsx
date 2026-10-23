import type { ReactElement } from 'react';

interface AccountPanelProps {
    onClose: () => void;
}

// The hub keeps the password, the passkeys and the sign-in of each person, so this panel only leads to its pages.
function AccountPanel({ onClose }: AccountPanelProps): ReactElement {
    return (
        <section className="people-panel" aria-labelledby="account-title">
            <header className="people-panel-header">
                <div>
                    <h1 id="account-title">Account</h1>
                    <p>How you sign in to this CloudBot.</p>
                </div>
                <button type="button" className="choice-button" aria-label="Close account panel" onClick={onClose}>Close</button>
            </header>
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
        </section>
    );
}

export { AccountPanel };
