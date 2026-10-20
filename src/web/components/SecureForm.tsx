import { useId, useState } from 'react';
import type { ReactElement, SyntheticEvent } from 'react';

interface SecureFormProps {
    prompt: string;
    secretName: string;
    submitted: boolean;
    onSubmit: (value: string) => void;
}

function SecureForm({ prompt, secretName, submitted, onSubmit }: SecureFormProps): ReactElement {
    const [value, setValue] = useState('');
    const inputId = useId();
    const isEmpty = value.length === 0;

    function handleSubmit(event: SyntheticEvent<HTMLFormElement>): void {
        event.preventDefault();

        if (isEmpty || submitted) {
            return;
        }

        // Clear the field first so the value is never kept in component state after submit.
        const submittedValue = value;

        setValue('');
        onSubmit(submittedValue);
    }

    if (submitted) {
        return (
            <div className="setup-card">
                <p>{prompt}</p>
                <p className="setup-done">
                    Stored as
                    {secretName}
                    . The bot can use it but cannot read it.
                </p>
            </div>
        );
    }

    return (
        <div className="setup-card">
            <p>{prompt}</p>
            <form className="setup-form" onSubmit={handleSubmit}>
                <label htmlFor={inputId}>{secretName}</label>
                <input
                    id={inputId}
                    type="password"
                    autoComplete="off"
                    value={value}
                    onChange={(event) => {
                        setValue(event.target.value);
                    }}
                />
                <button type="submit" disabled={isEmpty}>Save secret</button>
            </form>
        </div>
    );
}

export { SecureForm };
export type { SecureFormProps };
