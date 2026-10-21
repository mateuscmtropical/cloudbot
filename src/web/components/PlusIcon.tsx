import type { ReactElement } from 'react';

// Drawn as lines through the middle of the box, so the plus sits exactly in the center of a round button.
function PlusIcon(): ReactElement {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
        </svg>
    );
}

export { PlusIcon };
