import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { ProviderUsageSummary, ProviderUsageWindow } from '../../shared/providerTypes.ts';
import { getProviderUsage } from '../apiClient.ts';
import { PopoverMenuSection } from './PopoverMenu.tsx';

interface ProviderUsagePanelProps {
    // True while the menu is open. The CLIs are asked each time it opens, which can take several seconds.
    isOpen: boolean;
}

type UsageState = 'loading' | 'ready' | 'failed';

const RESET_FORMAT: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };

function describeReset(window: ProviderUsageWindow): string | null {
    if (window.resetsAt !== null) {
        const resetDate = new Date(window.resetsAt);

        return `resets ${resetDate.toLocaleString([], RESET_FORMAT)}`;
    }

    return window.resetsText === null ? null : `resets ${window.resetsText}`;
}

// How much of the plan limits each connected provider reports as used, like the usage screen of its own CLI.
function ProviderUsagePanel({ isOpen }: ProviderUsagePanelProps): ReactElement {
    const [usage, setUsage] = useState<ProviderUsageSummary[]>([]);
    const [state, setState] = useState<UsageState>('loading');

    useEffect(() => {
        if (!isOpen) {
            return undefined;
        }

        let isCurrent = true;

        getProviderUsage()
            .then((loaded) => {
                if (isCurrent) {
                    setUsage(loaded);
                    setState('ready');
                }
            })
            .catch(() => {
                if (isCurrent) {
                    setState('failed');
                }
            });

        return () => {
            isCurrent = false;
        };
    }, [isOpen]);

    return (
        <PopoverMenuSection title="Plan usage">
            {state === 'loading' && usage.length === 0 ? <p className="provider-note">Loading...</p> : null}
            {state === 'failed' && usage.length === 0 ? <p className="provider-note">The plan usage could not be loaded.</p> : null}
            {usage.map(summary => (
                <div key={summary.provider} className="usage-provider">
                    <span className="usage-provider-name">{summary.label}</span>
                    {summary.windows.length === 0
                        ? <span className="usage-note">Not available for this provider</span>
                        : summary.windows.map((window) => {
                                const reset = describeReset(window);
                                const percent = String(window.usedPercent);

                                return (
                                    <div key={window.label} className="usage-window">
                                        <span className="usage-note">{`${window.label}: ${percent}% used${reset === null ? '' : `, ${reset}`}`}</span>
                                        <progress className="usage-bar" max={100} value={Math.min(100, window.usedPercent)} aria-label={`${summary.label} ${window.label}`} />
                                    </div>
                                );
                            })}
                </div>
            ))}
        </PopoverMenuSection>
    );
}

export { ProviderUsagePanel };
export type { ProviderUsagePanelProps };
