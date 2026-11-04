// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PanelHeader } from './PanelHeader.tsx';

describe('PanelHeader', () => {
    afterEach(() => {
        cleanup();
    });

    it('closes from its button and names the panel with its title', () => {
        const onClose = vi.fn();

        render(
            <section aria-labelledby="panel-title">
                <PanelHeader closeLabel="Close panel" onClose={onClose} title="People" titleId="panel-title" description="Manage access" />
            </section>,
        );

        const closeButton = screen.getByRole('button', { name: 'Close panel' });

        fireEvent.click(closeButton);

        expect(onClose)
            .toHaveBeenCalledOnce();
        expect(screen.getByRole('region', { name: 'People' }))
            .toBeTruthy();
        expect(screen.getByText('Manage access'))
            .toBeTruthy();
    });

    it('leaves out the heading when there is no title and keeps the end controls', () => {
        render(<PanelHeader closeLabel="Back" onClose={vi.fn()}><span>Count</span></PanelHeader>);

        expect(screen.queryByRole('heading'))
            .toBeNull();
        expect(screen.getByText('Count'))
            .toBeTruthy();
    });
});
