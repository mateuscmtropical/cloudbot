import { useEffect, useRef, useState } from 'react';
import type { ReactElement, SyntheticEvent } from 'react';

import { DEFAULT_BITWARDEN_SERVER_URL } from '../../shared/bitwarden.ts';
import type { BitwardenStatus } from '../../shared/bitwarden.ts';
import { forgetBitwardenAccount, getBitwardenStatus, saveBitwardenAccount, testBitwardenAccount } from '../apiClient.ts';

interface BitwardenSetupFormProps {
    botId: string;
    onClose: () => void;
}

const SAVE_FAILED = 'The account could not be saved. Try again.';
const TEST_FAILED = 'The connection test could not run. Try again.';

// The server answers a refused field with a plain sentence, and that one is worth showing as it is.
function describeFailure(error: unknown, fallback: string): string {
    const serverMessage: unknown = error instanceof Error ? Reflect.get(error, 'serverMessage') : undefined;

    return typeof serverMessage === 'string' ? serverMessage : fallback;
}

// The bot types logins from the owner's Bitwarden vault, but never sees them. The owner saves the API key and the
// master password here once. They go to the server's vault, and this page never shows them again.
function BitwardenSetupForm({ botId, onClose }: BitwardenSetupFormProps): ReactElement {
    const [status, setStatus] = useState<BitwardenStatus | undefined>(undefined);
    const [serverUrl, setServerUrl] = useState(DEFAULT_BITWARDEN_SERVER_URL);
    const [clientId, setClientId] = useState('');
    const [clientSecret, setClientSecret] = useState('');
    const [masterPassword, setMasterPassword] = useState('');
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [testNote, setTestNote] = useState<string | undefined>(undefined);
    const [isBusy, setIsBusy] = useState(false);
    const formRef = useRef<HTMLElement>(null);

    // The form opens above a long list, so it scrolls into view.
    useEffect(() => {
        formRef.current?.scrollIntoView({ block: 'start' });
    }, []);

    useEffect(() => {
        let isCurrent = true;

        getBitwardenStatus(botId)
            .then((loaded) => {
                if (isCurrent) {
                    setStatus(loaded);
                }
            })
            .catch(() => {
                if (isCurrent) {
                    setProblem('The Bitwarden setup could not be loaded.');
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
        setTestNote(undefined);
        setIsBusy(true);

        const fields = { serverUrl: serverUrl.trim(), clientId: clientId.trim(), clientSecret: clientSecret.trim(), masterPassword };

        saveBitwardenAccount(botId, fields)
            .then((saved) => {
                setStatus(saved);
                setClientId('');
                setClientSecret('');
                setMasterPassword('');
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
        setTestNote(undefined);
        setIsBusy(true);

        forgetBitwardenAccount(botId)
            .then(() => {
                setStatus(current => (current === undefined ? current : { ...current, configured: false }));
            })
            .catch(() => {
                setProblem('The account could not be forgotten. Try again.');
            })
            .finally(() => {
                setIsBusy(false);
            });
    }

    function handleTest(): void {
        setProblem(undefined);
        setTestNote(undefined);
        setIsBusy(true);

        testBitwardenAccount(botId)
            .then((result) => {
                if (result.ok) {
                    setTestNote('Connection ok.');
                } else {
                    setProblem(result.error ?? TEST_FAILED);
                }
            })
            .catch(() => {
                setProblem(TEST_FAILED);
            })
            .finally(() => {
                setIsBusy(false);
            });
    }

    const canSave = clientId.trim().length > 0 && clientSecret.trim().length > 0 && masterPassword.length > 0 && !isBusy;

    return (
        <section ref={formRef} className="google-setup bitwarden-setup" aria-label="Bitwarden setup">
            <h2>Bitwarden setup</h2>
            <p>The bot can fill a website login from your Bitwarden vault. It never sees the values. You approve each login in the chat, and only on the site that the login is saved for.</p>
            <p>Use a separate Bitwarden account, or an organization collection, that holds only the logins the bot may use.</p>
            <p>In the Bitwarden web vault open Settings, Security, Keys and view your API key. Paste the client ID and the client secret below, with your master password. CloudBot keeps all three in its own vault, away from the bot.</p>
            {status?.configured === true
                ? (
                        <div className="google-setup-saved" role="status">
                            <span>{`Saved for ${status.serverUrl}.`}</span>
                            <button type="button" className="connect-app-action" disabled={isBusy} onClick={handleTest}>Test connection</button>
                            <button type="button" className="connect-app-action" disabled={isBusy} onClick={handleForget}>Forget</button>
                        </div>
                    )
                : (
                        <form className="google-setup-fields" onSubmit={handleSave}>
                            <label htmlFor="bitwarden-server-url">Server address</label>
                            <input
                                id="bitwarden-server-url"
                                type="url"
                                autoComplete="off"
                                spellCheck={false}
                                placeholder={DEFAULT_BITWARDEN_SERVER_URL}
                                value={serverUrl}
                                onChange={(event) => {
                                    setServerUrl(event.currentTarget.value);
                                }}
                            />
                            <label htmlFor="bitwarden-client-id">API client ID</label>
                            <input
                                id="bitwarden-client-id"
                                type="text"
                                autoComplete="off"
                                spellCheck={false}
                                placeholder="user.00000000-0000-0000-0000-000000000000"
                                value={clientId}
                                onChange={(event) => {
                                    setClientId(event.currentTarget.value);
                                }}
                            />
                            <label htmlFor="bitwarden-client-secret">API client secret</label>
                            <input
                                id="bitwarden-client-secret"
                                type="password"
                                autoComplete="off"
                                value={clientSecret}
                                onChange={(event) => {
                                    setClientSecret(event.currentTarget.value);
                                }}
                            />
                            <label htmlFor="bitwarden-master-password">Master password</label>
                            <input
                                id="bitwarden-master-password"
                                type="password"
                                autoComplete="off"
                                value={masterPassword}
                                onChange={(event) => {
                                    setMasterPassword(event.currentTarget.value);
                                }}
                            />
                            <button type="submit" className="connect-app-action" disabled={!canSave}>Save</button>
                        </form>
                    )}
            {testNote === undefined ? null : <p role="status">{testNote}</p>}
            {problem === undefined ? null : <p className="connect-app-problem" role="alert">{problem}</p>}
            <button type="button" className="connect-app-action" onClick={onClose}>Close Bitwarden setup</button>
        </section>
    );
}

export { BitwardenSetupForm };
export type { BitwardenSetupFormProps };
