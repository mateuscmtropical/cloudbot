// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChevronIcon } from './icons.tsx';
import { ListRow } from './ListRow.tsx';

describe('ListRow', () => {
    afterEach(cleanup);

    it('renders a plain row with its optional details and value', () => {
        render(<ListRow title="Computer" description="Ready to use" value="Idle" leadingIcon={<ChevronIcon />} chevron />);

        expect(screen.getByText('Computer'))
            .toBeTruthy();
        expect(screen.getByText('Ready to use'))
            .toBeTruthy();
        expect(screen.getByText('Idle'))
            .toBeTruthy();
        expect(screen.getByText('›'))
            .toBeTruthy();
    });

    it('renders a link when a destination is supplied', () => {
        render(<ListRow title="Account" href="/account" />);

        expect(screen.getByRole('link', { name: 'Account' })
            .getAttribute('href'))
            .toBe('/account');
    });

    it('renders a button and handles its action when clicked', () => {
        const onClick = vi.fn();

        render(<ListRow title="Open library" onClick={onClick} />);
        fireEvent.click(screen.getByRole('button', { name: 'Open library' }));

        expect(onClick)
            .toHaveBeenCalledTimes(1);
    });
});
