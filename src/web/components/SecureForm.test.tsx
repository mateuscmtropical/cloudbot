// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SecureForm } from './SecureForm.tsx';

const SECRET_VALUE = 'hunter2-secret';

describe('SecureForm', () => {
    afterEach(() => {
        cleanup();
    });

    it('hands the value to onSubmit and clears the field', () => {
        const onSubmit = vi.fn();

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
        render(<SecureForm prompt="Add your key" secretName="API_KEY" submitted={false} onSubmit={vi.fn()} />);

        fireEvent.change(screen.getByLabelText('API_KEY'), { target: { value: SECRET_VALUE } });
        fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));

        expect(document.body.innerHTML)
            .not.toContain(SECRET_VALUE);
    });
});
