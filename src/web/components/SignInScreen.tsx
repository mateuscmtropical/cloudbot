import { useState } from 'react';
import type { ReactElement } from 'react';

import { describePasskeyResult, signInWithPasskey } from '../passkeyClient.ts';
import { CloudMascot } from './CloudMascot.tsx';

const MASCOT_SIZE = 96;

// Shown when there is no session. A passkey signs in on this device, and the setup link from the server always works.
function SignInScreen(): ReactElement {
    const [isBusy, setIsBusy] = useState(false);
    const [problemText, setProblemText] = useState<string | undefined>(undefined);

    const signIn = (): void => {
        setIsBusy(true);
        setProblemText(undefined);
        const signInPromise = signInWithPasskey();

        void signInPromise.then((result) => {
            if (result === 'done') {
                window.location.reload();

                return;
            }

            const resultText = describePasskeyResult(result);

            setIsBusy(false);
            setProblemText(resultText);
        });
    };

    return (
        <main className="sign-in">
            <div className="sign-in-card">
                <CloudMascot color="blue" shape="puff" state="idle" size={MASCOT_SIZE} />
                <h1>CloudBot</h1>
                <p>Sign in with a passkey of this device, or open the setup link printed by the server.</p>
                <button type="button" className="sign-in-button" onClick={signIn} disabled={isBusy}>Sign in with a passkey</button>
                {problemText === undefined ? null : <p role="alert">{problemText}</p>}
            </div>
        </main>
    );
}

export { SignInScreen };
