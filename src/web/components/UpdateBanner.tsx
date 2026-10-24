import type { ReactElement } from 'react';

interface UpdateBannerProps {
    canApplyUpdate: boolean;
    onApply: () => void;
    onDismiss: () => void;
}

function UpdateBanner({ canApplyUpdate, onApply, onDismiss }: UpdateBannerProps): ReactElement {
    return (
        <div className="error-banner update-banner" role="status">
            <span>A new version is ready</span>
            <div className="update-banner-actions">
                <button
                    type="button"
                    className="update-banner-action"
                    disabled={!canApplyUpdate}
                    title={canApplyUpdate ? undefined : 'This browser cannot save the reload guard'}
                    onClick={onApply}
                >
                    Update
                </button>
                <button type="button" className="error-banner-dismiss" aria-label="Dismiss update" onClick={onDismiss}>×</button>
            </div>
        </div>
    );
}

export { UpdateBanner };
export type { UpdateBannerProps };
