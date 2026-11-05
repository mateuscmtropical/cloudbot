// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChannelSummary } from '../../shared/channelTypes.ts';
import type { BotSummary } from '../../shared/chatTypes.ts';
import { GroupDialog } from './GroupDialog.tsx';

function makeBot(id: string, name: string): BotSummary {
    return { id, name, title: '', mascotColor: 'blue', mascotShape: 'puff', mascotEyes: 'smile', mascotWeather: 'auto', mascotBolt: 'down', lastMessagePreview: '', hasUnread: false, lastMessageSequence: 0 };
}

const BOTS = [makeBot('ana', 'Ana'), makeBot('ben', 'Ben')];

describe('GroupDialog', () => {
    beforeAll(() => {
        HTMLDialogElement.prototype.showModal = vi.fn();
        HTMLDialogElement.prototype.close = vi.fn();
    });

    afterEach(cleanup);

    it('makes a group with the picked bots, the first one as manager, and isolated when asked', async () => {
        const onSave = vi.fn(() => Promise.resolve(undefined));
        const onClose = vi.fn();

        render(<GroupDialog bots={BOTS} onSave={onSave} onClose={onClose} />);

        const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save', hidden: true });

        expect(save.disabled)
            .toBe(true);

        fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Launch ' } });
        fireEvent.click(screen.getByLabelText('Ben'));
        fireEvent.click(screen.getByLabelText('Ana'));
        fireEvent.click(screen.getByRole('switch', { name: 'Isolated', hidden: true }));
        fireEvent.submit(save);

        await waitFor(() => {
            expect(onClose)
                .toHaveBeenCalledOnce();
        });
        expect(onSave)
            .toHaveBeenCalledWith({ name: 'Launch', memberIds: ['ben', 'ana'], managerId: 'ben', isIsolated: true });
    });

    it('keeps a refusal in the dialog, and picks a new manager when the old one leaves', async () => {
        const group: ChannelSummary = {
            id: 'group-1',
            name: 'Launch',
            isIsolated: false,
            members: [
                { botId: 'ana', name: 'Ana', mascotColor: 'blue', mascotShape: 'puff', mascotEyes: 'smile', isManager: false },
                { botId: 'ben', name: 'Ben', mascotColor: 'blue', mascotShape: 'puff', mascotEyes: 'smile', isManager: true },
            ],
        };
        const onSave = vi.fn(() => Promise.resolve('A group named Launch already exists.'));
        const onClose = vi.fn();

        render(<GroupDialog bots={BOTS} group={group} onSave={onSave} onDelete={vi.fn()} onClose={onClose} />);
        fireEvent.click(screen.getByLabelText('Ben'));
        fireEvent.submit(screen.getByRole('button', { name: 'Save', hidden: true }));

        const alert = await screen.findByRole('alert', { hidden: true });

        expect(alert.textContent)
            .toBe('A group named Launch already exists.');
        expect(onSave)
            .toHaveBeenCalledWith({ name: 'Launch', memberIds: ['ana'], managerId: 'ana', isIsolated: false });
        expect(onClose).not.toHaveBeenCalled();
    });
});
