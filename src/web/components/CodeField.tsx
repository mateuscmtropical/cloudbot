import { useState } from 'react';
import type { ReactElement, SyntheticEvent } from 'react';

interface CodeFieldProps {
    prompt: string;
    placeholder: string;
    submitted: boolean;
    onSubmit: (code: string) => void;
}

function CodeField({ prompt, placeholder, submitted, onSubmit }: CodeFieldProps): ReactElement {
    const [code, setCode] = useState('');
    const trimmedCode = code.trim();

    function handleSubmit(event: SyntheticEvent<HTMLFormElement>): void {
        event.preventDefault();

        if (trimmedCode.length === 0 || submitted) {
            return;
        }

        setCode('');
        onSubmit(trimmedCode);
    }

    return (
        <div className="setup-card">
            <p>{prompt}</p>
            {submitted
                ? (
                        <p className="setup-done">Sent</p>
                    )
                : (
                        <form className="setup-form" onSubmit={handleSubmit}>
                            <input
                                type="text"
                                autoComplete="one-time-code"
                                placeholder={placeholder}
                                value={code}
                                onChange={(event) => {
                                    setCode(event.target.value);
                                }}
                            />
                            <button type="submit" disabled={trimmedCode.length === 0}>Send code</button>
                        </form>
                    )}
        </div>
    );
}

export { CodeField };
export type { CodeFieldProps };
