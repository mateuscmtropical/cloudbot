// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlusIcon } from './icons.tsx';
import { RoundButton } from './RoundButton.tsx';

describe('RoundButton', () => {
    afterEach(cleanup);

    it('uses its label and calls its click handler', () => {
        const onClick = vi.fn();
        const { container } = render(<RoundButton label="Create bot" onClick={onClick}><PlusIcon /></RoundButton>);
        const button = screen.getByRole('button', { name: 'Create bot' });

        fireEvent.click(button);

        expect(onClick)
            .toHaveBeenCalledTimes(1);
        expect(container.querySelector('.round-button'))
            .toBe(button);
    });

    it('applies the selected tone', () => {
        const { container } = render(<RoundButton label="Owner" tone="avatar" onClick={vi.fn()}>MR</RoundButton>);

        expect(container.querySelector('.round-button-avatar'))
            .toBeTruthy();
    });
});
