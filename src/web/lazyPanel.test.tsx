// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { createElement, Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { lazyPanel } from './lazyPanel.ts';

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('lazyPanel', () => {
    it('renders the panel once its chunk is there', async () => {
        const panel = lazyPanel(() => Promise.resolve(() => <p>Panel</p>));
        const element = createElement(panel);

        render(<Suspense fallback={null}>{element}</Suspense>);

        expect(await screen.findByText('Panel'))
            .toBeTruthy();
    });

    it('reloads the page when the chunk is gone', async () => {
        const reload = vi.spyOn(window.location, 'reload')
            .mockImplementation(() => undefined);
        const panel = lazyPanel(() => Promise.reject(new Error('Chunk is gone')));
        const element = createElement(panel);

        render(<Suspense fallback={<p>Waiting</p>}>{element}</Suspense>);

        await vi.waitFor(() => {
            expect(reload)
                .toHaveBeenCalledTimes(1);
        });
        expect(screen.getByText('Waiting'))
            .toBeTruthy();
    });
});
