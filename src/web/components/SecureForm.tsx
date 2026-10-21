import { useId, useState } from 'react';
import type { ReactElement, SyntheticEvent } from 'react';

// Another way to answer the form. Both answers are disabled while either one is pending.
interface SecureFormAlternative {
    label: string;
    // Settles when the server answered.
    onSelect: () => Promise<void>;
}

type PendingAnswer = 'submit' | 'alternative';

interface SecureFormProps {
    prompt: string;
    secretName: string;
    submitted: boolean;
    // Settles when the server answered. The key check can take a few seconds.
    onSubmit: (value: string) => Promise<void>;
    alternative?: SecureFormAlternative | undefined;
    // Set when the bot asked for the secret. The value is used only on this site.
    site?: string | undefined;
}

function SecureForm({ prompt, secretName, submitted, onSubmit, alternative, site }: SecureFormProps): ReactElement {
    const [value, setValue] = useState('');
    const [pendingAnswer, setPendingAnswer] = useState<PendingAnswer | undefined>(undefined);
    const inputId = useId();
    const isEmpty = value.length === 0;
    const isPending = pendingAnswer !== undefined;

    function waitFor(answer: PendingAnswer, answerPromise: Promise<void>): void {
        setPendingAnswer(answer);
        void answerPromise.finally(() => {
            setPendingAnswer(undefined);
        });
    }

    function handleSubmit(event: SyntheticEvent<HTMLFormElement>): void {
        event.preventDefault();

        if (isEmpty || submitted || isPending) {
            return;
        }

        // Clear the field first so the value is never kept in component state after submit.
        const submittedValue = value;
        const submitPromise = onSubmit(submittedValue);

        setValue('');
        waitFor('submit', submitPromise);
    }

    function handleAlternative(selected: SecureFormAlternative): void {
        if (submitted || isPending) {
            return;
        }

        // A typed value must not stay in component state after the form is left.
        setValue('');

        const selectPromise = selected.onSelect();

        waitFor('alternative', selectPromise);
    }

    if (submitted) {
        return (
            <div className="setup-card">
                <p>{prompt}</p>
                <p className="setup-done">
                    This form is closed. Check the conversation for the result.
                </p>
            </div>
        );
    }

    return (
        <div className="setup-card">
            <p>{prompt}</p>
            {site === undefined
                ? null
                : <p className="secret-site">{`The bot asks for this. It is for ${site}, and the bot never sees the value.`}</p>}
            <form className="setup-form" onSubmit={handleSubmit}>
                <label htmlFor={inputId}>{secretName}</label>
                <input
                    id={inputId}
                    type="password"
                    autoComplete="off"
                    value={value}
                    disabled={isPending}
                    onChange={(event) => {
                        setValue(event.target.value);
                    }}
                />
                <button type="submit" disabled={isEmpty || isPending}>
                    {pendingAnswer === 'submit' ? 'Checking...' : 'Save secret'}
                </button>
            </form>
            {alternative !== undefined && (
                <button
                    type="button"
                    className="choice-button setup-alternative"
                    disabled={isPending}
                    onClick={() => {
                        handleAlternative(alternative);
                    }}
                >
                    {alternative.label}
                </button>
            )}
        </div>
    );
}

export { SecureForm };
export type { SecureFormProps };
