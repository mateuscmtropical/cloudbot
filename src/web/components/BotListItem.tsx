import type { MouseEvent, PointerEvent, ReactElement } from 'react';

import type { BotSummary } from '../../shared/chatTypes.ts';
import type { MascotState } from '../mascotState.ts';
import { formatBotActivityTime } from '../formatBotActivityTime.ts';
import { usePressHold } from '../usePressHold.ts';
import { CloudMascot } from './CloudMascot.tsx';

interface BotListItemProps {
    bot: BotSummary;
    isSelected: boolean;
    mascotState: MascotState;
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
    onClick: (event: MouseEvent<HTMLButtonElement>) => void;
    actions?: ReactElement | undefined;
    onOpenActions?: (() => void) | undefined;
}

function BotListItem({ bot, isSelected, mascotState, onPointerUp, onClick, actions, onOpenActions }: BotListItemProps): ReactElement {
    const selectedClassName = isSelected ? 'bot-item is-selected' : 'bot-item';
    const itemClassName = bot.hasUnread ? `${selectedClassName} is-unread` : selectedClassName;
    const activityLabel = formatBotActivityTime(bot.lastActivityAt);
    const activityDateTime = bot.lastActivityAt === undefined || !Number.isFinite(bot.lastActivityAt)
        ? undefined
        : new Date(bot.lastActivityAt)
                .toISOString();
    const pressHold = usePressHold(onOpenActions, onOpenActions);

    function handlePointerUp(event: PointerEvent<HTMLButtonElement>): void {
        const didHold = pressHold.didTrigger();

        pressHold.onPointerUp(event);

        if (!didHold) {
            onPointerUp(event);
        }
    }

    return (
        <div className="bot-list-item-wrap">
            <button
                type="button"
                className={itemClassName}
                aria-current={isSelected ? 'true' : undefined}
                onPointerDown={pressHold.onPointerDown}
                onPointerMove={pressHold.onPointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={pressHold.onPointerCancel}
                onClickCapture={pressHold.onClickCapture}
                onContextMenu={pressHold.onContextMenu}
                onClick={onClick}
            >
                <CloudMascot color={bot.mascotColor} shape={bot.mascotShape} eyes={bot.mascotEyes} state={mascotState} size={44} />
                <span className="bot-text">
                    <span className="bot-name-line">
                        <span className="bot-name">{bot.name}</span>
                        {activityLabel === '' || activityDateTime === undefined ? null : <time className="bot-time" dateTime={activityDateTime}>{activityLabel}</time>}
                    </span>
                    <span className="bot-preview">{bot.lastMessagePreview}</span>
                </span>
                {bot.hasUnread ? <span className="unread-dot" aria-label="Unread" /> : null}
            </button>
            {actions === undefined ? null : <div className="bot-actions-menu">{actions}</div>}
        </div>
    );
}

export { BotListItem };
export type { BotListItemProps };
