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
    isOpen?: boolean;
    onOpenChange?: (isOpen: boolean) => void;
}

type PopoverMenuItemTone = 'default' | 'danger';

interface PopoverMenuItemProps {
    label: string;
    icon: ReactNode;
    onSelect: () => void;
    close: () => void;
    tone?: PopoverMenuItemTone;
}

function PopoverMenuItem({ label, icon, onSelect, close, tone = 'default' }: PopoverMenuItemProps): ReactElement {
    const className = tone === 'danger' ? 'popover-menu-item is-danger' : 'popover-menu-item';

    return (
        <button
            type="button"
            className={className}
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

function PopoverMenu({ label, triggerLabel, triggerIcon, children, placement = 'below-end', disabled = false, isOpen: controlledIsOpen, onOpenChange }: PopoverMenuProps): ReactElement {
    const [localIsOpen, setLocalIsOpen] = useState(false);
    const isOpen = !disabled && (controlledIsOpen ?? localIsOpen);
    const menuId = useId();
    const triggerId = useId();
    const containerRef = useRef<HTMLDivElement>(null);

    const updateIsOpen = useCallback((nextIsOpen: boolean): void => {
        if (controlledIsOpen === undefined) {
            setLocalIsOpen(nextIsOpen);
        }

        onOpenChange?.(nextIsOpen);
    }, [controlledIsOpen, onOpenChange]);

    const focusTrigger = useCallback((): void => {
        document.getElementById(triggerId)
            ?.focus();
    }, [triggerId]);

    const close = useCallback((): void => {
        focusTrigger();
        updateIsOpen(false);
    }, [focusTrigger, updateIsOpen]);

    useEffect(() => {
        if (!isOpen) {
            return undefined;
        }

        function closeOnOutsidePointer(event: PointerEvent): void {
            if (event.target instanceof Node && containerRef.current?.contains(event.target) !== true) {
                updateIsOpen(false);
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
    }, [close, disabled, isOpen, updateIsOpen]);

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
                    updateIsOpen(!isOpen);
                }}
            >
                {triggerIcon}
            </RoundButton>
            <div id={menuId} className="popover-menu-popover" role="dialog" aria-label={label} hidden={!isOpen}>
                {children(close)}
            </div>
        </div>
    );
}

export { PopoverMenu, PopoverMenuItem };
export type { PopoverMenuItemProps, PopoverMenuItemTone, PopoverMenuPlacement, PopoverMenuProps };
