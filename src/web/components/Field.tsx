import type { ReactElement, ReactNode } from 'react';

interface FieldProps {
    label: string;
    children: ReactNode;
    // Puts the label to the left of the control, for narrow settings rows.
    isInline?: boolean;
}

function Field({ label, children, isInline = false }: FieldProps): ReactElement {
    return (
        <label className={isInline ? 'field is-inline' : 'field'}>
            <span className="field-label">{label}</span>
            {children}
        </label>
    );
}

export { Field };
export type { FieldProps };
