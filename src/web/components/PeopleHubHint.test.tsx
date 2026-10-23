// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PeopleHubHint } from './PeopleHubHint.tsx';

describe('PeopleHubHint', () => {
    afterEach(cleanup);

    it('says that people need the hub and points to the install steps', () => {
        render(<PeopleHubHint onClose={vi.fn()} />);

        expect(screen.getByText(/install CloudBot as a hub/))
            .toBeTruthy();
        expect(screen.getByText(/docs\/INSTALL.md/))
            .toBeTruthy();
    });

    it('closes from the button', () => {
        const onClose = vi.fn();

        render(<PeopleHubHint onClose={onClose} />);
        fireEvent.click(screen.getByRole('button', { name: 'Close people panel' }));

        expect(onClose)
            .toHaveBeenCalledTimes(1);
    });
});
