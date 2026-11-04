import type { ReactElement, SelectHTMLAttributes } from 'react';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
    label: string;
}

// A styled native select. The phone shows its own picker and the keyboard works for free.
function Select({ label, ...selectProps }: SelectProps): ReactElement {
    return <select {...selectProps} className="select" aria-label={label} />;
}

export { Select };
export type { SelectProps };
