// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RenameField } from './RenameField.tsx';

afterEach(() => {
    cleanup();
});

function renderField(onSubmit: (name: string) => Promise<string | undefined>, onClose: () => void = () => {}): HTMLInputElement {
    render(<RenameField name="Ana" label="Name of Ana" onSubmit={onSubmit} onClose={onClose} />);

    return screen.getByRole('textbox', { name: 'Name of Ana' });
}

describe('RenameField', () => {
    it('starts with the name in the field, focused', () => {
        const input = renderField(() => Promise.resolve(undefined));

        expect(input.value)
            .toBe('Ana');
        expect(document.activeElement)
            .toBe(input);
    });

    it('saves the trimmed name on Enter and closes', async () => {
        const onSubmit = vi.fn(() => Promise.resolve(undefined));
        const onClose = vi.fn();
        const input = renderField(onSubmit, onClose);

        fireEvent.change(input, { target: { value: '  Maria ' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(onClose)
                .toHaveBeenCalledTimes(1);
        });
        expect(onSubmit)
            .toHaveBeenCalledWith('Maria');
    });

    it('closes without a request when the name did not change', () => {
        const onSubmit = vi.fn(() => Promise.resolve(undefined));
        const onClose = vi.fn();
        const input = renderField(onSubmit, onClose);

        fireEvent.keyDown(input, { key: 'Enter' });

        expect(onSubmit)
            .not
            .toHaveBeenCalled();
        expect(onClose)
            .toHaveBeenCalledTimes(1);
    });

    it('cancels on Escape and when the field loses focus', () => {
        const onSubmit = vi.fn(() => Promise.resolve(undefined));
        const onClose = vi.fn();
        const input = renderField(onSubmit, onClose);

        fireEvent.keyDown(input, { key: 'Escape' });
        fireEvent.blur(input);

        expect(onClose)
            .toHaveBeenCalledTimes(2);
        expect(onSubmit)
            .not
            .toHaveBeenCalled();
    });

    it('shows why the name was refused, stays open and lets the owner try again', async () => {
        const onSubmit = vi.fn()
            .mockResolvedValueOnce('Pick another name.')
            .mockResolvedValueOnce(undefined);
        const onClose = vi.fn();
        const input = renderField(onSubmit, onClose);

        fireEvent.change(input, { target: { value: 'Ben' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        expect((await screen.findByRole('alert')).textContent)
            .toBe('Pick another name.');
        expect(onClose)
            .not
            .toHaveBeenCalled();

        fireEvent.change(input, { target: { value: 'Bea' } });

        expect(screen.queryByRole('alert'))
            .toBeNull();

        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(onClose)
                .toHaveBeenCalledTimes(1);
        });
    });

    it('says so when the request itself fails', async () => {
        const input = renderField(() => Promise.reject(new Error('offline')));

        fireEvent.change(input, { target: { value: 'Ben' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        expect((await screen.findByRole('alert')).textContent)
            .toBe('The name could not be changed.');
    });
});
