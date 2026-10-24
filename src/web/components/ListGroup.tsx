import type { ReactNode } from 'react';
import type { ReactElement } from 'react';

interface ListGroupProps {
    children: ReactNode;
    label?: string | undefined;
    ariaLabel?: string | undefined;
    className?: string | undefined;
}

function ListGroup({ children, label, ariaLabel, className }: ListGroupProps): ReactElement {
    const rootClassName = className === undefined ? 'list-group' : `list-group ${className}`;
    const sectionLabel = ariaLabel ?? label;

    return (
        <section className={rootClassName} aria-label={sectionLabel}>
            {label === undefined ? null : <h2 className="list-group-label">{label}</h2>}
            <div className="list-group-rows">{children}</div>
        </section>
    );
}

export { ListGroup };
export type { ListGroupProps };
