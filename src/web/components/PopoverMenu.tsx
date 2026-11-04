import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { RoundButton } from './RoundButton.tsx';

type PopoverMenuPlacement = 'above-start' | 'above-end' | 'below-start' | 'below-end';

// A menu is a short list of actions. A panel has settings sections, is wider, scrolls and is a bottom sheet on a phone.
type PopoverMenuVariant = 'menu' | 'panel';

interface PopoverMenuProps {
    label: string;
    triggerLabel: string;
    triggerIcon: ReactNode;
    children: (close: () => void, isOpen: boolean) => ReactNode;
    placement?: PopoverMenuPlacement;
    variant?: PopoverMenuVariant;
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

interface PopoverMenuSectionProps {
    title: string;
    children: ReactNode;
}

function PopoverMenuSection({ title, children }: PopoverMenuSectionProps): ReactElement {
    return (
        <section className="popover-menu-section" aria-label={title}>
            <h3 className="popover-menu-section-title">{title}</h3>
            {children}
        </section>
    );
}

// The popover stays mounted while closed, so its children keep their state and the close can animate.
function PopoverMenu({ label, triggerLabel, triggerIcon, children, placement = 'below-end', variant = 'menu', disabled = false, isOpen: controlledIsOpen, onOpenChange }: PopoverMenuProps): ReactElement {
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
        <div className={`popover-menu-anchor is-${placement} is-${variant}`} ref={containerRef}>
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
            {variant === 'panel'
                ? (
                        <button
                            type="button"
                            className="scrim popover-menu-scrim"
                            aria-label={`Close ${label}`}
                            tabIndex={-1}
                            hidden={!isOpen}
                            onClick={close}
                        />
                    )
                : null}
            <div id={menuId} className="popover-menu-popover" role="dialog" aria-label={label} hidden={!isOpen}>
                {children(close, isOpen)}
            </div>
        </div>
    );
}

export { PopoverMenu, PopoverMenuItem, PopoverMenuSection };
export type { PopoverMenuItemProps, PopoverMenuItemTone, PopoverMenuPlacement, PopoverMenuProps, PopoverMenuSectionProps, PopoverMenuVariant };
