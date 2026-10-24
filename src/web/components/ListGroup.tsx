import type { ReactNode } from 'react';
import type { ReactElement } from 'react';

interface ListGroupProps {
    children: ReactNode;
    label?: string;
    className?: string;
}

function ListGroup({ children, label, className }: ListGroupProps): ReactElement {
    const rootClassName = className === undefined ? 'list-group' : `list-group ${className}`;

    return (
        <section className={rootClassName} aria-label={label}>
            {label === undefined ? null : <h2 className="list-group-label">{label}</h2>}
            <div className="list-group-rows">{children}</div>
        </section>
    );
}

export { ListGroup };
export type { ListGroupProps };
