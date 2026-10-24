import type { CSSProperties, ReactElement } from 'react';

import { RefreshIcon } from './icons.tsx';

interface PullIndicatorProps {
    distance: number;
    isRefreshing: boolean;
}

function PullIndicator({ distance, isRefreshing }: PullIndicatorProps): ReactElement {
    const style = {
        '--pull-distance': String(distance) + 'px',
        '--pull-rotation': String(distance * 3) + 'deg',
    } as CSSProperties;
    const indicatorClass = isRefreshing ? 'pull-indicator is-visible is-refreshing' : (distance > 0 ? 'pull-indicator is-visible' : 'pull-indicator');

    return (
        <div
            className={indicatorClass}
            style={style}
            role={isRefreshing ? 'status' : undefined}
            aria-label={isRefreshing ? 'Reloading the app' : undefined}
            aria-hidden={!isRefreshing}
        >
            <RefreshIcon />
        </div>
    );
}

export { PullIndicator };
export type { PullIndicatorProps };
