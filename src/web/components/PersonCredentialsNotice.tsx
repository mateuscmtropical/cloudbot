import { useState } from 'react';
import type { ReactElement } from 'react';

import { Button } from './Button.tsx';
import { Field } from './Field.tsx';

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
            <Field label="Address">
                <input
                    type="text"
                    readOnly
                    aria-label="Sign-in address"
                    value={address}
                    onFocus={(event) => {
                        event.currentTarget.select();
                    }}
                />
            </Field>
            <Field label="Password">
                <input
                    type="text"
                    readOnly
                    aria-label="Sign-in password"
                    value={password}
                    onFocus={(event) => {
                        event.currentTarget.select();
                    }}
                />
            </Field>
            <Button onClick={() => { void copySignInDetails(); }}>{copyLabel}</Button>
            <Button onClick={onHide}>Hide details</Button>
        </section>
    );
}

export { PersonCredentialsNotice };
export type { PersonCredentialsNoticeProps };
