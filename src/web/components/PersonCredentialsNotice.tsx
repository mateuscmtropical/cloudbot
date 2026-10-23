import { useState } from 'react';
import type { ReactElement } from 'react';

interface PersonCredentialsNoticeProps {
    name: string;
    address: string;
    password: string;
    onHide: () => void;
}

function PersonCredentialsNotice({ name, address, password, onHide }: PersonCredentialsNoticeProps): ReactElement {
    const [copyLabel, setCopyLabel] = useState('Copy sign-in details');

    async function copySignInDetails(): Promise<void> {
        try {
            const signInDetails = `Address: ${address}\nPassword: ${password}`;

            await navigator.clipboard.writeText(signInDetails);
            setCopyLabel('Copied');
        } catch {
            setCopyLabel('Copy failed');
        }
    }

    return (
        <section className="webhook-created person-credentials-created" role="status" aria-label="One-time sign-in details">
            <p><strong>{`Sign-in details for ${name}`}</strong></p>
            <p>Save this now. It is not shown again.</p>
            <label>
                Address
                <input
                    type="text"
                    readOnly
                    aria-label="Sign-in address"
                    value={address}
                    onFocus={(event) => {
                        event.currentTarget.select();
                    }}
                />
            </label>
            <label>
                Password
                <input
                    type="text"
                    readOnly
                    aria-label="Sign-in password"
                    value={password}
                    onFocus={(event) => {
                        event.currentTarget.select();
                    }}
                />
            </label>
            <button type="button" onClick={() => { void copySignInDetails(); }}>{copyLabel}</button>
            <button type="button" onClick={onHide}>Hide details</button>
        </section>
    );
}

export { PersonCredentialsNotice };
export type { PersonCredentialsNoticeProps };
