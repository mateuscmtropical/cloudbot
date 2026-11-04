import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { BotSummary } from '../../shared/chatTypes.ts';
import { SNIPPET_MARK_END, SNIPPET_MARK_START } from '../../shared/searchTypes.ts';
import type { MessageSearchHit } from '../../shared/searchTypes.ts';
import { searchMessages } from '../apiClient.ts';
import { CloudMascot } from './CloudMascot.tsx';
import { ListRow } from './ListRow.tsx';

const MIN_QUERY_LENGTH = 2;
const TYPING_PAUSE_MS = 250;
const SNIPPET_MARK_PATTERN = new RegExp(`[${SNIPPET_MARK_START}${SNIPPET_MARK_END}]`);

interface MessageSearchResultsProps {
    query: string;
    bots: BotSummary[];
    onOpenHit: (hit: MessageSearchHit) => void;
}

interface SearchResults {
    query: string;
    hits: MessageSearchHit[];
}

interface SnippetTextProps {
    snippet: string;
}

// The text between the marks of a snippet shows highlighted. It stays text, so a message can never add markup.
function SnippetText({ snippet }: SnippetTextProps): ReactElement {
    const parts = snippet.split(SNIPPET_MARK_PATTERN);
    // A mark starts every second part, since the snippet alternates plain text and matches.
    const pieces = parts.map((part, partIndex) => (partIndex % 2 === 1 ? <mark key={partIndex}>{part}</mark> : <span key={partIndex}>{part}</span>));

    return <>{pieces}</>;
}

function MessageSearchResults({ query, bots, onOpenHit }: MessageSearchResultsProps): ReactElement | null {
    const [results, setResults] = useState<SearchResults | undefined>(undefined);
    const trimmedQuery = query.trim();
    const isQueryLongEnough = trimmedQuery.length >= MIN_QUERY_LENGTH;

    useEffect(() => {
        if (!isQueryLongEnough) {
            return undefined;
        }

        let isCurrent = true;
        const timer = window.setTimeout(() => {
            searchMessages(trimmedQuery)
                .then((hits) => {
                    if (isCurrent) {
                        setResults({ query: trimmedQuery, hits });
                    }
                })
                .catch(() => undefined);
        }, TYPING_PAUSE_MS);

        return () => {
            isCurrent = false;
            window.clearTimeout(timer);
        };
    }, [trimmedQuery, isQueryLongEnough]);

    if (!isQueryLongEnough || results === undefined) {
        return null;
    }

    if (results.hits.length === 0) {
        return results.query === trimmedQuery ? <p className="channel-section-title">No messages found</p> : null;
    }

    return (
        <>
            <p className="channel-section-title">Messages</p>
            {results.hits.map((hit) => {
                const bot = bots.find(candidate => candidate.id === hit.botId);

                return bot === undefined
                    ? null
                    : (
                            <ListRow
                                key={hit.messageId}
                                title={bot.name}
                                description={<SnippetText snippet={hit.snippet} />}
                                leadingIcon={<CloudMascot color={bot.mascotColor} shape={bot.mascotShape} eyes={bot.mascotEyes} state="idle" size={40} />}
                                className="bot-item channel-list-row message-search-hit"
                                onClick={() => {
                                    onOpenHit(hit);
                                }}
                            />
                        );
            })}
        </>
    );
}

export { MessageSearchResults };
