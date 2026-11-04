// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDetail, ChannelPostView } from '../../shared/channelTypes.ts';
import { ChannelView } from './ChannelView.tsx';

function makePost(id: string, role: ChannelPostView['role'], authorName: string, text: string): ChannelPostView {
    return { id, sequence: 1, createdAt: 1, authorName, authorColor: 'blue', authorShape: 'puff', authorEyes: 'smile', role, body: { kind: 'text', text } };
}

const GROUP: ChannelDetail = {
    id: 'group-1',
    name: 'Launch',
    isIsolated: false,
    hasActiveRound: false,
    members: [{ botId: 'ana', name: 'Ana', mascotColor: 'blue', mascotShape: 'puff', mascotEyes: 'smile', isManager: true }],
    messages: [makePost('post-1', 'user', 'You', 'Plan it'), makePost('post-2', 'assistant', 'Ana', '**Done**')],
};

describe('ChannelView', () => {
    afterEach(cleanup);

    it('renders Markdown with the name of the bot, and no mascot on the owner post', () => {
        const { container } = render(<ChannelView channel={GROUP} onPost={vi.fn()} onStop={vi.fn()} onOpenBotList={vi.fn()} onEdit={vi.fn()} />);
        const botPost = container.querySelector('[data-message-id="post-2"]');
        const ownerPost = container.querySelector('[data-message-id="post-1"]');

        expect(botPost?.querySelector('strong')?.textContent)
            .toBe('Done');
        expect(botPost?.querySelector('.handoff-sender')?.textContent)
            .toBe('Ana');
        expect(ownerPost?.querySelector('.cloud-mascot'))
            .toBeNull();
    });

    it('posts through the composer, has no attach button, and offers Stop while a round runs', () => {
        const onPost = vi.fn();
        const onStop = vi.fn();
        const { rerender } = render(<ChannelView channel={GROUP} onPost={onPost} onStop={onStop} onOpenBotList={vi.fn()} onEdit={vi.fn()} />);

        fireEvent.change(screen.getByPlaceholderText('Ask Launch...'), { target: { value: 'Hello' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));

        expect(onPost)
            .toHaveBeenCalledWith('Hello');
        expect(screen.queryByRole('button', { name: 'Attach files' }))
            .toBeNull();

        rerender(<ChannelView channel={{ ...GROUP, hasActiveRound: true }} onPost={onPost} onStop={onStop} onOpenBotList={vi.fn()} onEdit={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

        expect(onStop)
            .toHaveBeenCalledOnce();
    });
});
