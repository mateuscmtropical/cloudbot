import type { ReactElement } from 'react';

// Drawn as two lines through the middle of the box, so the cross sits exactly in the center of a round button.
// A text cross sits on the font baseline, so it looks off center.
function CloseIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
        </svg>
    );
}

export { CloseIcon };
