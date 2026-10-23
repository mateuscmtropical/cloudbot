import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';

interface RenameFieldProps {
    name: string;
    // What the screen reader says for the field, such as "Name of Ana".
    label: string;
    className?: string | undefined;
    // Saves the name. It answers the reason the name was refused, or nothing when it was saved.
    onSubmit: (name: string) => Promise<string | undefined>;
    onClose: () => void;
}

// The name of a bot as a text field. Enter saves. Escape, or leaving the field, cancels.
function RenameField({ name, label, className, onSubmit, onClose }: RenameFieldProps): ReactElement {
    const [value, setValue] = useState(name);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [isSaving, setIsSaving] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);

    function save(): void {
        const trimmed = value.trim();

        if (trimmed === name) {
            onClose();

            return;
        }

        setIsSaving(true);
        onSubmit(trimmed)
            .then((refusal) => {
                if (refusal === undefined) {
                    onClose();

                    return;
                }

                setProblem(refusal);
                setIsSaving(false);
            })
            .catch(() => {
                setProblem('The name could not be changed.');
                setIsSaving(false);
            });
    }

    function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
        // Enter during IME composition belongs to the IME.
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            save();
        }

        if (event.key === 'Escape') {
            onClose();
        }
    }

    return (
        <span className="rename-field">
            <input
                ref={inputRef}
                type="text"
                className={className === undefined ? 'rename-input' : `rename-input ${className}`}
                aria-label={label}
                value={value}
                maxLength={40}
                readOnly={isSaving}
                onChange={(event) => {
                    setValue(event.target.value);
                    setProblem(undefined);
                }}
                onKeyDown={handleKeyDown}
                onBlur={() => {
                    if (!isSaving) {
                        onClose();
                    }
                }}
            />
            {problem === undefined ? null : <span className="rename-problem" role="alert">{problem}</span>}
        </span>
    );
}

export { RenameField };
export type { RenameFieldProps };
