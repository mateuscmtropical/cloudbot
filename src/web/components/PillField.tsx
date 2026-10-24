import type { ReactNode } from 'react';
import type { ReactElement } from 'react';

interface PillFieldProps {
    children: ReactNode;
    leftIcon?: ReactNode;
    className?: string;
}

function PillField({ children, leftIcon, className }: PillFieldProps): ReactElement {
    const rootClassName = className === undefined ? 'pill-field' : `pill-field ${className}`;

    return (
        <div className={rootClassName}>
            {leftIcon === undefined ? null : <span className="pill-field-icon" aria-hidden="true">{leftIcon}</span>}
            {children}
        </div>
    );
}

export { PillField };
export type { PillFieldProps };
