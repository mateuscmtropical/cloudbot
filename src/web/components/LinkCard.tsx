import type { ReactElement } from 'react';

import { isSafeUrl } from '../markdown.ts';

interface LinkCardProps {
    label: string;
    url: string;
}

function LinkCard({ label, url }: LinkCardProps): ReactElement {
    if (!isSafeUrl(url)) {
        return <span className="link-card">{label}</span>;
    }

    return (
        <a className="link-card" href={url} target="_blank" rel="noopener noreferrer">
            {label}
        </a>
    );
}

export { LinkCard };
export type { LinkCardProps };
