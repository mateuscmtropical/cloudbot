import type { ReactNode } from 'react';
import type { ReactElement } from 'react';

type RoundButtonTone = 'default' | 'avatar' | 'accent';

interface RoundButtonProps {
    label: string;
    onClick: () => void;
    children: ReactNode;
    id?: string;
    tone?: RoundButtonTone;
    disabled?: boolean;
    ariaExpanded?: boolean;
    ariaHaspopup?: 'dialog' | 'menu' | boolean;
    ariaControls?: string;
}

function RoundButton({ label, onClick, children, id, tone = 'default', disabled = false, ariaExpanded, ariaHaspopup, ariaControls }: RoundButtonProps): ReactElement {
    return (
        <button
            type="button"
            id={id}
            className={`round-button round-button-${tone}`}
            aria-label={label}
            aria-expanded={ariaExpanded}
            aria-haspopup={ariaHaspopup}
            aria-controls={ariaControls}
            disabled={disabled}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

export { RoundButton };
export type { RoundButtonProps, RoundButtonTone };
