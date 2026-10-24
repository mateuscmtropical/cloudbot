import type { ReactNode } from 'react';
import type { ReactElement } from 'react';

type RoundButtonTone = 'default' | 'avatar' | 'accent';

interface RoundButtonProps {
    label: string;
    onClick: () => void;
    children: ReactNode;
    tone?: RoundButtonTone;
}

function RoundButton({ label, onClick, children, tone = 'default' }: RoundButtonProps): ReactElement {
    return (
        <button type="button" className={`round-button round-button-${tone}`} aria-label={label} onClick={onClick}>
            {children}
        </button>
    );
}

export { RoundButton };
export type { RoundButtonProps, RoundButtonTone };
