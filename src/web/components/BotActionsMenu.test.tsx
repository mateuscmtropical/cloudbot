// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BotActionsMenu } from './BotActionsMenu.tsx';

interface MenuProbeProps {
    onRename: () => void;
    onDelete: () => void;
}

function MenuProbe({ onRename, onDelete }: MenuProbeProps): ReactElement {
    const [isOpen, setIsOpen] = useState(false);

    return <BotActionsMenu botName="Ana" isOpen={isOpen} onOpenChange={setIsOpen} onRename={onRename} onDelete={onDelete} />;
}

describe('BotActionsMenu', () => {
    afterEach(cleanup);

    it('opens for one bot and runs the shared Rename and Delete actions', () => {
        const onRename = vi.fn();
        const onDelete = vi.fn();

        render(<MenuProbe onRename={onRename} onDelete={onDelete} />);

        fireEvent.click(screen.getByRole('button', { name: 'More options for Ana' }));

        const menu = screen.getByRole('dialog', { name: 'Actions for Ana' });
        const deleteButton = screen.getByRole('button', { name: 'Delete' });

        expect(menu)
            .toBeTruthy();
        expect(deleteButton.classList.contains('is-danger'))
            .toBe(true);

        fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
        expect(onRename)
            .toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog', { name: 'Actions for Ana' }))
            .toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'More options for Ana' }));
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
        expect(onDelete)
            .toHaveBeenCalledTimes(1);
    });
});
