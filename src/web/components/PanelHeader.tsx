import type { ReactElement, ReactNode } from 'react';

import { CloseIcon } from './icons.tsx';
import { RoundButton } from './RoundButton.tsx';

interface PanelHeaderProps {
    closeLabel: string;
    onClose: () => void;
    closeIcon?: ReactNode;
    title?: string;
    titleId?: string;
    description?: string;
    className?: string;
    // Controls at the end of the row.
    children?: ReactNode;
}

// The top row of a full page panel: the way back, the title, then any controls.
function PanelHeader({ closeLabel, onClose, closeIcon = <CloseIcon />, title, titleId, description, className, children }: PanelHeaderProps): ReactElement {
    const headerClass = className === undefined ? 'panel-header' : `panel-header ${className}`;

    return (
        <header className={headerClass}>
            <RoundButton label={closeLabel} onClick={onClose}>{closeIcon}</RoundButton>
            {title === undefined
                ? null
                : (
                        <div className="panel-header-title">
                            <h1 id={titleId}>{title}</h1>
                            {description === undefined ? null : <p>{description}</p>}
                        </div>
                    )}
            {children}
        </header>
    );
}

export { PanelHeader };
export type { PanelHeaderProps };
