// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SecureForm } from './SecureForm.tsx';

const SECRET_VALUE = 'hunter2-secret';

describe('SecureForm', () => {
    afterEach(() => {
        cleanup();
    });

    it('hands the value to onSubmit and clears the field', () => {
        const onSubmit = vi.fn(() => Promise.resolve());

        render(<SecureForm prompt="Add your key" secretName="API_KEY" submitted={false} onSubmit={onSubmit} />);

        const input = screen.getByLabelText<HTMLInputElement>('API_KEY');

        fireEvent.change(input, { target: { value: SECRET_VALUE } });
        fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));

        expect(onSubmit)
            .toHaveBeenCalledWith(SECRET_VALUE);
        expect(input.value)
            .toBe('');
    });

    it('never writes the secret into the DOM after submit', () => {
        const onSubmit = vi.fn(() => Promise.resolve());

        render(<SecureForm prompt="Add your key" secretName="API_KEY" submitted={false} onSubmit={onSubmit} />);

        fireEvent.change(screen.getByLabelText('API_KEY'), { target: { value: SECRET_VALUE } });
        fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));

        expect(document.body.innerHTML)
            .not.toContain(SECRET_VALUE);
    });

    it('shows that the value is being checked until the server answers', async () => {
        const answer = Promise.withResolvers<undefined>();
        const onSubmit = vi.fn(() => answer.promise);

        render(<SecureForm prompt="Add your key" secretName="API_KEY" submitted={false} onSubmit={onSubmit} />);

        const input = screen.getByLabelText<HTMLInputElement>('API_KEY');

        fireEvent.change(input, { target: { value: SECRET_VALUE } });
        fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));

        const checkingButton = screen.getByRole<HTMLButtonElement>('button', { name: 'Checking...' });

        expect(checkingButton.disabled)
            .toBe(true);
        expect(input.disabled)
            .toBe(true);

        await act(async () => {
            answer.resolve(undefined);
            await answer.promise;
        });

        expect(input.disabled)
            .toBe(false);
        expect(screen.getByRole('button', { name: 'Save secret' }))
            .toBeDefined();
    });

    it('disables the alternative answer while the value is checked', async () => {
        const answer = Promise.withResolvers<undefined>();
        const onSelect = vi.fn(() => Promise.resolve());
        const alternative = { label: 'Use subscription instead', onSelect };

        render(<SecureForm prompt="Add your key" secretName="API_KEY" submitted={false} onSubmit={() => answer.promise} alternative={alternative} />);

        fireEvent.change(screen.getByLabelText('API_KEY'), { target: { value: SECRET_VALUE } });
        fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));

        const alternativeButton = screen.getByRole<HTMLButtonElement>('button', { name: 'Use subscription instead' });

        expect(alternativeButton.disabled)
            .toBe(true);

        await act(async () => {
            answer.resolve(undefined);
            await answer.promise;
        });

        expect(alternativeButton.disabled)
            .toBe(false);
        fireEvent.click(alternativeButton);
        expect(onSelect)
            .toHaveBeenCalledOnce();
    });

    it('sends the alternative answer once on a double click', () => {
        const pending = Promise.withResolvers<undefined>();
        const onSelect = vi.fn(() => pending.promise);
        const alternative = { label: 'Use subscription instead', onSelect };

        render(<SecureForm prompt="Add your key" secretName="API_KEY" submitted={false} onSubmit={() => Promise.resolve()} alternative={alternative} />);

        const alternativeButton = screen.getByRole<HTMLButtonElement>('button', { name: 'Use subscription instead' });

        fireEvent.click(alternativeButton);
        fireEvent.click(alternativeButton);
        expect(onSelect)
            .toHaveBeenCalledOnce();
        expect(alternativeButton.disabled)
            .toBe(true);
    });

    it('clears a typed value when the alternative is chosen', () => {
        const alternative = { label: 'Use subscription instead', onSelect: vi.fn(() => Promise.resolve()) };

        render(<SecureForm prompt="Add your key" secretName="API_KEY" submitted={false} onSubmit={() => Promise.resolve()} alternative={alternative} />);

        const input = screen.getByLabelText<HTMLInputElement>('API_KEY');

        fireEvent.change(input, { target: { value: SECRET_VALUE } });
        fireEvent.click(screen.getByRole('button', { name: 'Use subscription instead' }));
        expect(input.value)
            .toBe('');
    });
});
