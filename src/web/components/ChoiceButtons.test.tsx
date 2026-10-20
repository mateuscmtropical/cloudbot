// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChoiceButtons } from './ChoiceButtons.tsx';

const options = [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
];

describe('ChoiceButtons', () => {
    afterEach(() => {
        cleanup();
    });

    it('calls onChoose with the id of the clicked option', () => {
        const onChoose = vi.fn();

        render(<ChoiceButtons options={options} chosenId={undefined} onChoose={onChoose} />);
        fireEvent.click(screen.getByRole('button', { name: 'No' }));

        expect(onChoose)
            .toHaveBeenCalledWith('no');
    });

    it('disables every option once one is chosen', () => {
        render(<ChoiceButtons options={options} chosenId="yes" onChoose={vi.fn()} />);

        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Yes' }).disabled)
            .toBe(true);
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'No' }).disabled)
            .toBe(true);
    });
});
