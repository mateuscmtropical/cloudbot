// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SearchIcon } from './icons.tsx';
import { PillField } from './PillField.tsx';

describe('PillField', () => {
    afterEach(cleanup);

    it('wraps a control and an optional leading icon', () => {
        const { container } = render(
            <PillField leftIcon={<SearchIcon />}>
                <input aria-label="Search bots" />
            </PillField>,
        );

        expect(screen.getByRole('textbox', { name: 'Search bots' }))
            .toBeTruthy();
        expect(container.querySelector('.pill-field-icon svg'))
            .toBeTruthy();
    });

    it('keeps the field general when there is no leading icon', () => {
        const { container } = render(<PillField><textarea aria-label="Message" /></PillField>);

        expect(screen.getByRole('textbox', { name: 'Message' }))
            .toBeTruthy();
        expect(container.querySelector('.pill-field-icon'))
            .toBeNull();
    });
});
