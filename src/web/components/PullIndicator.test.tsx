// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PullIndicator } from './PullIndicator.tsx';

describe('PullIndicator', () => {
    it('follows the resisted drag with a rotated refresh icon', () => {
        const { container } = render(<PullIndicator distance={35} isRefreshing={false} />);
        const indicator = container.querySelector('.pull-indicator');

        expect(indicator?.classList.contains('is-visible'))
            .toBe(true);
        expect(indicator?.getAttribute('style'))
            .toContain('--pull-distance: 35px');
        expect(indicator?.getAttribute('style'))
            .toContain('--pull-rotation: 105deg');
        expect(indicator?.querySelector('svg'))
            .not.toBeNull();
    });

    it('announces the refresh state while spinning', () => {
        const { container } = render(<PullIndicator distance={70} isRefreshing />);
        const indicator = container.querySelector('.pull-indicator');

        expect(indicator?.classList.contains('is-refreshing'))
            .toBe(true);
        expect(indicator?.getAttribute('role'))
            .toBe('status');
        expect(indicator?.getAttribute('aria-label'))
            .toBe('Reloading the app');
    });
});
