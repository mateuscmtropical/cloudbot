import type { MouseEvent, PointerEvent, ReactElement } from 'react';

import type { BotSummary } from '../../shared/chatTypes.ts';
import type { MascotState } from '../mascotState.ts';
import { formatBotActivityTime } from '../formatBotActivityTime.ts';
import { CloudMascot } from './CloudMascot.tsx';

interface BotListItemProps {
    bot: BotSummary;
    isSelected: boolean;
    mascotState: MascotState;
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
    onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}

function BotListItem({ bot, isSelected, mascotState, onPointerUp, onClick }: BotListItemProps): ReactElement {
    const selectedClassName = isSelected ? 'bot-item is-selected' : 'bot-item';
    const itemClassName = bot.hasUnread ? `${selectedClassName} is-unread` : selectedClassName;
    const activityLabel = formatBotActivityTime(bot.lastActivityAt);
    const activityDateTime = bot.lastActivityAt === undefined || !Number.isFinite(bot.lastActivityAt)
        ? undefined
        : new Date(bot.lastActivityAt)
                .toISOString();

    return (
        <button
            type="button"
            className={itemClassName}
            aria-current={isSelected ? 'true' : undefined}
            onPointerUp={onPointerUp}
            onClick={onClick}
        >
            <CloudMascot color={bot.mascotColor} shape={bot.mascotShape} state={mascotState} size={44} />
            <span className="bot-text">
                <span className="bot-name-line">
                    <span className="bot-name">{bot.name}</span>
                    {activityLabel === '' || activityDateTime === undefined ? null : <time className="bot-time" dateTime={activityDateTime}>{activityLabel}</time>}
                </span>
                <span className="bot-preview">{bot.lastMessagePreview}</span>
            </span>
            {bot.hasUnread ? <span className="unread-dot" aria-label="Unread" /> : null}
        </button>
    );
}

export { BotListItem };
export type { BotListItemProps };
