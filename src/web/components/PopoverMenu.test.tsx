// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PopoverMenu, PopoverMenuItem } from './PopoverMenu.tsx';
import { MoreIcon, PlusIcon } from './icons.tsx';

describe('PopoverMenu', () => {
    afterEach(() => {
        cleanup();
    });

    it('opens from its round button and closes after an item is selected', () => {
        const onSelect = vi.fn();

        render(
            <PopoverMenu label="Conversation options" triggerLabel="More options" triggerIcon={<MoreIcon />}>
                {close => <PopoverMenuItem label="Choose file" icon={<PlusIcon />} close={close} onSelect={onSelect} />}
            </PopoverMenu>,
        );

        const trigger = screen.getByRole('button', { name: 'More options' });

        fireEvent.click(trigger);

        expect(screen.getByRole('dialog', { name: 'Conversation options' }))
            .toBeTruthy();
        expect(trigger.getAttribute('aria-expanded'))
            .toBe('true');

        fireEvent.click(screen.getByRole('button', { name: 'Choose file' }));

        expect(onSelect)
            .toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog', { name: 'Conversation options' }))
            .toBeNull();
        expect(trigger.getAttribute('aria-expanded'))
            .toBe('false');
    });

    it('closes when Escape is pressed or the owner clicks outside', () => {
        const view = render(
            <PopoverMenu label="Attachment options" triggerLabel="Attach files" triggerIcon={<PlusIcon />}>
                {() => <input aria-label="Model select" />}
            </PopoverMenu>,
        );

        const trigger = screen.getByRole('button', { name: 'Attach files' });

        fireEvent.click(trigger);
        const modelSelect = view.container.querySelector<HTMLInputElement>('input[aria-label="Model select"]');

        if (modelSelect === null) {
            throw new Error('The model select is missing');
        }

        modelSelect.focus();
        fireEvent.keyDown(modelSelect, { key: 'Escape' });

        expect(screen.queryByRole('dialog', { name: 'Attachment options' }))
            .toBeNull();
        expect(document.activeElement)
            .toBe(trigger);

        fireEvent.click(trigger);
        fireEvent.pointerDown(document.body);

        expect(screen.queryByRole('dialog', { name: 'Attachment options' }))
            .toBeNull();
    });

    it('keeps child state mounted while the popover is closed', () => {
        const view = render(
            <PopoverMenu label="Conversation options" triggerLabel="More options" triggerIcon={<MoreIcon />}>
                {() => <input aria-label="Model draft" defaultValue="Default model" />}
            </PopoverMenu>,
        );

        fireEvent.click(screen.getByRole('button', { name: 'More options' }));
        const modelDraft = view.container.querySelector<HTMLInputElement>('input[aria-label="Model draft"]');

        if (modelDraft === null) {
            throw new Error('The model draft is missing');
        }

        fireEvent.change(modelDraft, { target: { value: 'Selected model' } });
        fireEvent.keyDown(document, { key: 'Escape' });

        expect(screen.queryByRole('dialog', { name: 'Conversation options' }))
            .toBeNull();
        expect(modelDraft.isConnected)
            .toBe(true);

        fireEvent.click(screen.getByRole('button', { name: 'More options' }));

        expect(view.container.querySelector('input[aria-label="Model draft"]'))
            .toBe(modelDraft);
        expect(modelDraft.value)
            .toBe('Selected model');
    });
});
