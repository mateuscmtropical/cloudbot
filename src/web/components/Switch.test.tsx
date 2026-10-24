// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Switch } from './Switch.tsx';

describe('Switch', () => {
    afterEach(cleanup);

    it('keeps the native checkbox switch accessible and reports changes', () => {
        const onChange = vi.fn();

        render(<Switch label="Notifications" checked={false} onChange={onChange} />);
        const control = screen.getByRole('switch', { name: 'Notifications' });

        fireEvent.click(control);

        expect(onChange)
            .toHaveBeenCalledTimes(1);
    });

    it('passes the disabled state through to the input', () => {
        render(<Switch label="Notifications" checked={false} disabled onChange={vi.fn()} />);

        expect(screen.getByRole('switch', { name: 'Notifications' })
            .hasAttribute('disabled'))
            .toBe(true);
    });
});
