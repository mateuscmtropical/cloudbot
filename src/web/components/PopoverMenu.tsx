import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { RoundButton } from './RoundButton.tsx';

type PopoverMenuPlacement = 'above-start' | 'above-end' | 'below-start' | 'below-end';

interface PopoverMenuProps {
    label: string;
    triggerLabel: string;
    triggerIcon: ReactNode;
    children: (close: () => void) => ReactNode;
    placement?: PopoverMenuPlacement;
    disabled?: boolean;
}

interface PopoverMenuItemProps {
    label: string;
    icon: ReactNode;
    onSelect: () => void;
    close: () => void;
}

function PopoverMenuItem({ label, icon, onSelect, close }: PopoverMenuItemProps): ReactElement {
    return (
        <button
            type="button"
            className="popover-menu-item"
            onClick={() => {
                close();
                onSelect();
            }}
        >
            <span className="popover-menu-item-icon" aria-hidden="true">{icon}</span>
            <span>{label}</span>
        </button>
    );
}

function PopoverMenu({ label, triggerLabel, triggerIcon, children, placement = 'below-end', disabled = false }: PopoverMenuProps): ReactElement {
    const [isOpen, setIsOpen] = useState(false);
    const menuId = useId();
    const triggerId = useId();
    const containerRef = useRef<HTMLDivElement>(null);
    const [previousDisabled, setPreviousDisabled] = useState(disabled);

    if (previousDisabled !== disabled) {
        setPreviousDisabled(disabled);

        if (disabled) {
            setIsOpen(false);
        }
    }

    const focusTrigger = useCallback((): void => {
        document.getElementById(triggerId)
            ?.focus();
    }, [triggerId]);

    const close = useCallback((): void => {
        focusTrigger();
        setIsOpen(false);
    }, [focusTrigger]);

    useEffect(() => {
        if (!isOpen || disabled) {
            return undefined;
        }

        function closeOnOutsidePointer(event: PointerEvent): void {
            if (event.target instanceof Node && containerRef.current?.contains(event.target) !== true) {
                setIsOpen(false);
            }
        }

        function closeOnEscape(event: KeyboardEvent): void {
            if (event.key === 'Escape') {
                close();
            }
        }

        document.addEventListener('pointerdown', closeOnOutsidePointer);
        document.addEventListener('keydown', closeOnEscape);

        return () => {
            document.removeEventListener('pointerdown', closeOnOutsidePointer);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [close, disabled, isOpen]);

    return (
        <div className={`popover-menu-anchor is-${placement}`} ref={containerRef}>
            <RoundButton
                label={triggerLabel}
                id={triggerId}
                ariaExpanded={isOpen}
                ariaHaspopup="dialog"
                ariaControls={menuId}
                disabled={disabled}
                onClick={() => {
                    setIsOpen(current => !current);
                }}
            >
                {triggerIcon}
            </RoundButton>
            <div id={menuId} className="popover-menu-popover" role="dialog" aria-label={label} hidden={!isOpen || disabled}>
                {children(close)}
            </div>
        </div>
    );
}

export { PopoverMenu, PopoverMenuItem };
export type { PopoverMenuItemProps, PopoverMenuPlacement, PopoverMenuProps };
