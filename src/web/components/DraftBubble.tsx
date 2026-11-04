import { createElement, memo, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';

import type { DraftStore } from '../draftStore.ts';
import { renderDraftMarkdown, splitDraftMarkdown } from '../markdown.ts';

interface DraftBlockProps {
    markdown: string;
}

interface FinishedBlocksProps {
    blocks: string[];
}

interface DraftBubbleProps {
    store: DraftStore;
    botId: string | undefined;
    // Runs after each change of the text, so the list can stay at the bottom.
    onTextChange: () => void;
}

function DraftBlockView({ markdown }: DraftBlockProps): ReactElement {
    const html = useMemo(() => renderDraftMarkdown(markdown), [markdown]);

    return <div className="markdown-part" dangerouslySetInnerHTML={{ __html: html }} />;
}

const memoizedDraftBlock = memo(DraftBlockView);

function FinishedBlocksView({ blocks }: FinishedBlocksProps): ReactElement[] {
    return blocks.map((block, index) => createElement(memoizedDraftBlock, { key: String(index), markdown: block }));
}

// Finished blocks never change, so a new one is the only reason to look at them again. A long reply then costs one
// parse per block and no walk over the blocks on each frame.
const memoizedFinishedBlocks = memo(FinishedBlocksView, (previous, next) => previous.blocks.length === next.blocks.length
    && previous.blocks.at(-1) === next.blocks.at(-1));

// The reply being streamed. This is the only part of the app that renders per delta.
function DraftBubble({ store, botId, onTextChange }: DraftBubbleProps): ReactElement | null {
    const text = useSyncExternalStore(store.subscribe, () => {
        const draft = store.get();

        return draft.botId === botId ? draft.text : '';
    });
    const blocks = useMemo(() => splitDraftMarkdown(text), [text]);

    useLayoutEffect(() => {
        onTextChange();
    }, [text, onTextChange]);

    if (text === '') {
        return null;
    }

    return (
        <div className="message message-assistant is-draft">
            <div className="bubble markdown">
                {createElement(memoizedFinishedBlocks, { blocks: blocks.slice(0, -1) })}
                {createElement(memoizedDraftBlock, { markdown: blocks.at(-1) ?? '' })}
            </div>
        </div>
    );
}

export { DraftBubble };
