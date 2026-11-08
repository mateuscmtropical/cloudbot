// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type { InstanceUsage, ServerUsage } from '../../shared/usageTypes.ts';
import { UsagePanel } from './UsagePanel.tsx';

const GB = 1024 ** 3;
const OWN: InstanceUsage = { name: 'maria', role: 'member', instance: 'running', numbers: { cpuPercent: 42.4, cpuLimitPercent: 150, memoryBytes: 1.5 * GB, memoryLimitBytes: 2.5 * GB } };
const SERVER: ServerUsage = {
    host: { cpuCount: 4, loadAverage: 1.25, memoryTotalBytes: 8 * GB, memoryUsedBytes: 4 * GB, diskTotalBytes: 100 * GB, diskUsedBytes: 40 * GB },
    instances: [
        { name: 'owner', role: 'owner', instance: 'running', numbers: OWN.numbers },
        { name: 'joao', role: 'member', instance: 'stopped', numbers: null },
        { name: 'team', role: 'group', instance: 'running', numbers: { cpuPercent: 5, cpuLimitPercent: 150, memoryBytes: GB, memoryLimitBytes: 2 * GB } },
    ],
};

function stubFetch(answers: Record<string, unknown>): Mock<(path: string) => Promise<Response>> {
    const fetchStub = vi.fn((path: string) => {
        const answer = answers[path];

        return Promise.resolve(answer === undefined ? Response.json({ error: 'No.' }, { status: 404 }) : Response.json(answer));
    });

    vi.stubGlobal('fetch', fetchStub);

    return fetchStub;
}

describe('UsagePanel', () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('shows a person only their own instance and never asks for the server numbers', async () => {
        const fetchStub = stubFetch({ '/api/usage/me': OWN });

        render(<UsagePanel isOwner={false} onClose={vi.fn()} pollMs={100000} />);

        expect(await screen.findByText('CPU: 42% of 1.5 cores'))
            .toBeTruthy();
        expect(screen.getByText('Memory: 1.5 GB of 2.5 GB'))
            .toBeTruthy();
        expect(screen.queryByText('Machine'))
            .toBeNull();
        expect(fetchStub.mock.calls.map(call => call[0]))
            .toEqual(['/api/usage/me']);
    });

    it('shows the owner the machine, hibernated people and shared groups', async () => {
        stubFetch({ '/api/usage': SERVER });

        render(<UsagePanel isOwner onClose={vi.fn()} pollMs={100000} />);

        expect(await screen.findByText('Load: 1.25 on 4 cores'))
            .toBeTruthy();
        expect(screen.getByText('Used: 40.0 GB of 100 GB'))
            .toBeTruthy();
        expect(screen.getByText('Hibernated. It starts again when someone opens it.'))
            .toBeTruthy();
        expect(screen.getByText('Shared group'))
            .toBeTruthy();
        expect(screen.getByText(/read from inside the hub container/))
            .toBeTruthy();
    });

    it('looks again after the wait and keeps the numbers when a look fails', async () => {
        const fetchStub = stubFetch({ '/api/usage/me': OWN });

        render(<UsagePanel isOwner={false} onClose={vi.fn()} pollMs={20} />);
        await screen.findByText('CPU: 42% of 1.5 cores');
        fetchStub.mockRejectedValue(new Error('down'));

        expect(await screen.findByRole('alert'))
            .toBeTruthy();
        await waitFor(() => {
            expect(fetchStub.mock.calls.length)
                .toBeGreaterThan(2);
        });
        expect(screen.getByText('CPU: 42% of 1.5 cores'))
            .toBeTruthy();
    });
});
