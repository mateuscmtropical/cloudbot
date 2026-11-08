// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getProviderUsage } from '../apiClient.ts';
import { ProviderUsagePanel } from './ProviderUsagePanel.tsx';

vi.mock('../apiClient.ts', () => ({
    getProviderUsage: vi.fn(),
}));

describe('ProviderUsagePanel', () => {
    afterEach(() => {
        cleanup();
        vi.resetAllMocks();
    });

    it('shows the limits of a provider and says when another one has no usage', async () => {
        vi.mocked(getProviderUsage)
            .mockResolvedValue([
                { provider: 'claude', label: 'Claude', windows: [{ label: 'Session', usedPercent: 25, resetsAt: null, resetsText: 'Nov 7, 11pm (America/Sao_Paulo)' }] },
                { provider: 'gemini', label: 'Gemini', windows: [] },
            ]);

        render(<ProviderUsagePanel isOpen={true} />);

        expect(await screen.findByText('Session: 25% used, resets Nov 7, 11pm (America/Sao_Paulo)'))
            .toBeTruthy();
        expect(screen.getByText('Not available for this provider'))
            .toBeTruthy();
        const bar = screen.getByRole('progressbar', { name: 'Claude Session' });

        expect(bar.getAttribute('value'))
            .toBe('25');
    });

    it('formats an epoch reset time in the browser', async () => {
        vi.mocked(getProviderUsage)
            .mockResolvedValue([{ provider: 'chatgpt', label: 'ChatGPT', windows: [{ label: 'Weekly limit', usedPercent: 40, resetsAt: Date.UTC(2027, 0, 1, 12), resetsText: null }] }]);

        render(<ProviderUsagePanel isOpen={true} />);

        const resetDate = new Date(Date.UTC(2027, 0, 1, 12));
        const resetText = resetDate.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

        expect(await screen.findByText(`Weekly limit: 40% used, resets ${resetText}`))
            .toBeTruthy();
    });

    it('does not ask while the menu is closed and shows a failure', async () => {
        vi.mocked(getProviderUsage)
            .mockRejectedValue(new Error('down'));

        const { rerender } = render(<ProviderUsagePanel isOpen={false} />);

        expect(getProviderUsage)
            .not.toHaveBeenCalled();

        rerender(<ProviderUsagePanel isOpen={true} />);

        expect(await screen.findByText('The plan usage could not be loaded.'))
            .toBeTruthy();
    });
});
