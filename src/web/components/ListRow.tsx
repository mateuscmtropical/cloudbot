import type { MouseEventHandler, ReactNode } from 'react';
import type { ReactElement } from 'react';

interface ListRowProps {
    title: string;
    description?: string;
    value?: string | undefined;
    leadingIcon?: ReactNode;
    trailingControl?: ReactNode;
    chevron?: boolean;
    href?: string | undefined;
    ariaLabel?: string | undefined;
    ariaCurrent?: boolean | undefined;
    onClick?: MouseEventHandler<HTMLButtonElement> | undefined;
    className?: string | undefined;
}

function ListRowContent({ title, description, value, leadingIcon, trailingControl, chevron }: ListRowProps): ReactElement {
    return (
        <>
            {leadingIcon === undefined ? null : <span className="list-row-leading" aria-hidden="true">{leadingIcon}</span>}
            <span className="list-row-copy">
                <span className="list-row-title">{title}</span>
                {description === undefined ? null : <span className="list-row-description">{description}</span>}
            </span>
            {value === undefined ? null : <span className="list-row-value">{value}</span>}
            {trailingControl === undefined ? null : <span className="list-row-control">{trailingControl}</span>}
            {chevron === true ? <span className="list-row-chevron" aria-hidden="true">›</span> : null}
        </>
    );
}

function ListRow(props: ListRowProps): ReactElement {
    const { href, onClick, className, ariaCurrent } = props;
    const rootClassName = className === undefined ? 'list-row' : `list-row ${className}`;
    const content = <ListRowContent {...props} />;

    if (href !== undefined) {
        return <a className={rootClassName} href={href} aria-label={props.ariaLabel} aria-current={ariaCurrent === true ? 'true' : undefined}>{content}</a>;
    }

    if (onClick !== undefined) {
        return <button type="button" className={rootClassName} aria-label={props.ariaLabel} aria-current={ariaCurrent === true ? 'true' : undefined} onClick={onClick}>{content}</button>;
    }

    return <div className={rootClassName}>{content}</div>;
}

export { ListRow };
export type { ListRowProps };
