import { useEffect, useRef, useState } from 'react';
import type { ReactElement, SyntheticEvent } from 'react';

import type { GoogleClientStatus } from '../../shared/connectedApps.ts';
import { forgetGoogleClient, getGoogleClient, saveGoogleClient } from '../apiClient.ts';

interface GoogleSetupFormProps {
    botId: string;
    // Called after the client was saved, so the panel can go on with the sign-in the owner started.
    onSaved: () => void;
    onClose: () => void;
}

const SAVE_FAILED = 'The client could not be saved. Try again.';

// The server answers a refused client with a plain sentence, and that one is worth showing as it is.
function describeFailure(error: unknown, fallback: string): string {
    const serverMessage: unknown = error instanceof Error ? Reflect.get(error, 'serverMessage') : undefined;

    return typeof serverMessage === 'string' ? serverMessage : fallback;
}

// Google gives no automatic sign-up for apps, so the owner makes a client of their own in Google Cloud and saves it here.
// The secret goes to the server's vault. This page never shows it again.
function GoogleSetupForm({ botId, onSaved, onClose }: GoogleSetupFormProps): ReactElement {
    const [status, setStatus] = useState<GoogleClientStatus | undefined>(undefined);
    const [clientId, setClientId] = useState('');
    const [clientSecret, setClientSecret] = useState('');
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [isBusy, setIsBusy] = useState(false);
    const [isCopied, setIsCopied] = useState(false);
    const formRef = useRef<HTMLElement>(null);

    // The form opens above a long list, so it scrolls into view.
    useEffect(() => {
        formRef.current?.scrollIntoView({ block: 'start' });
    }, []);

    useEffect(() => {
        let isCurrent = true;

        getGoogleClient(botId)
            .then((loaded) => {
                if (isCurrent) {
                    setStatus(loaded);
                }
            })
            .catch(() => {
                if (isCurrent) {
                    setProblem('The Google setup could not be loaded.');
                }
            });

        return () => {
            isCurrent = false;
        };
    }, [botId]);

    function handleSave(event: SyntheticEvent<HTMLFormElement>): void {
        event.preventDefault();

        if (isBusy) {
            return;
        }

        setProblem(undefined);
        setIsBusy(true);

        const trimmedId = clientId.trim();
        const trimmedSecret = clientSecret.trim();

        saveGoogleClient(botId, trimmedId, trimmedSecret)
            .then((saved) => {
                setStatus(saved);
                setClientId('');
                setClientSecret('');
                onSaved();
            })
            .catch((error: unknown) => {
                const message = describeFailure(error, SAVE_FAILED);

                setProblem(message);
            })
            .finally(() => {
                setIsBusy(false);
            });
    }

    function handleForget(): void {
        setProblem(undefined);
        setIsBusy(true);

        forgetGoogleClient(botId)
            .then(() => {
                setStatus(current => (current === undefined ? current : { ...current, configured: false }));
            })
            .catch(() => {
                setProblem('The client could not be forgotten. Try again.');
            })
            .finally(() => {
                setIsBusy(false);
            });
    }

    function handleCopy(address: string): void {
        // A page without clipboard access throws at once, and the promise turns that into the same failure.
        Promise.resolve()
            .then(() => navigator.clipboard.writeText(address))
            .then(() => {
                setIsCopied(true);
            })
            .catch(() => {
                setProblem('The address could not be copied. Select it and copy it by hand.');
            });
    }

    const redirectUri = status?.redirectUri;
    const canSave = clientId.trim().length > 0 && clientSecret.trim().length > 0 && !isBusy;

    return (
        <section ref={formRef} className="google-setup" aria-label="Google setup">
            <h2>Google setup</h2>
            <p>One Google sign-in connects Gmail, Calendar, Drive, Docs and Sheets. It uses a Google Cloud client that you create once.</p>
            <ol className="google-setup-steps">
                <li>Join the Google Workspace Developer Preview Program with your Google account.</li>
                <li>In Google Cloud, turn on the MCP API and the product API of each app you want. For Gmail these are the Gmail MCP API and the Gmail API.</li>
                <li>Create an OAuth client of type Web application. Tick the box &quot;Use this client for an AI-powered agent&quot;.</li>
                <li>
                    Add this redirect address to the client.
                    {redirectUri === undefined
                        ? null
                        : (
                                <span className="google-setup-address">
                                    <code>{redirectUri}</code>
                                    <button
                                        type="button"
                                        className="connect-app-action"
                                        aria-label="Copy redirect address"
                                        onClick={() => {
                                            handleCopy(redirectUri);
                                        }}
                                    >
                                        {isCopied ? 'Copied' : 'Copy'}
                                    </button>
                                </span>
                            )}
                </li>
                <li>Paste the client ID and the client secret below.</li>
            </ol>
            <p>While the Google Cloud app is in Testing, Google ends each sign-in after 7 days.</p>
            {status?.configured === true
                ? (
                        <p className="google-setup-saved" role="status">
                            Client saved.
                            <button type="button" className="connect-app-action" disabled={isBusy} onClick={handleForget}>Forget</button>
                        </p>
                    )
                : (
                        <form className="google-setup-fields" onSubmit={handleSave}>
                            <label htmlFor="google-client-id">Client ID</label>
                            <input
                                id="google-client-id"
                                type="text"
                                autoComplete="off"
                                spellCheck={false}
                                placeholder="1234-abc.apps.googleusercontent.com"
                                value={clientId}
                                onChange={(event) => {
                                    setClientId(event.currentTarget.value);
                                }}
                            />
                            <label htmlFor="google-client-secret">Client secret</label>
                            <input
                                id="google-client-secret"
                                type="password"
                                autoComplete="off"
                                value={clientSecret}
                                onChange={(event) => {
                                    setClientSecret(event.currentTarget.value);
                                }}
                            />
                            <button type="submit" className="connect-app-action" disabled={!canSave}>Save</button>
                        </form>
                    )}
            {problem === undefined ? null : <p className="connect-app-problem" role="alert">{problem}</p>}
            <button type="button" className="connect-app-action" onClick={onClose}>Close Google setup</button>
        </section>
    );
}

export { GoogleSetupForm };
export type { GoogleSetupFormProps };
