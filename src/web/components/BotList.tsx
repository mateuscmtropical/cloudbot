import { useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { BotSummary } from '../../shared/chatTypes.ts';
import type { ChannelSummary } from '../../shared/channelTypes.ts';
import type { MascotState } from '../mascotState.ts';
import { nextTap } from '../doubleTap.ts';
import type { Tap } from '../doubleTap.ts';
import type { MascotHopPoint } from '../mascotHop.ts';
import { AppsGridIcon, PeopleIcon, PlusIcon, SearchIcon } from './icons.tsx';
import { BotActionsMenu } from './BotActionsMenu.tsx';
import { BotListItem } from './BotListItem.tsx';
import { CloudMascot } from './CloudMascot.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { ListRow } from './ListRow.tsx';
import { PillField } from './PillField.tsx';
import { RenameField } from './RenameField.tsx';
import { RoundButton } from './RoundButton.tsx';

// Where the hop lands on the row, inside its rounded right end.
const ROW_EDGE_INSET = 24;

interface BotListProps {
    bots: BotSummary[];
    selectedBotId: string | undefined;
    // The face of the selected bot, which is the live one. The other bots show the idle face.
    selectedMascotState: MascotState;
    channels: ChannelSummary[];
    selectedChannelId: string | undefined;
    isOpen: boolean;
    onSelectBot: (botId: string, sourceMascot: HTMLElement | null, rowEdge: MascotHopPoint) => void;
    onSelectChannel: (channelId: string) => void;
    onNewBot: () => void;
    onConnectApps: () => void;
    personName?: string | undefined;
    // Opens Account for the owner, whether or not this CloudBot is in a hub.
    onAccount?: (() => void) | undefined;
    onPeople?: (() => void) | undefined;
    // Saves a new name for a bot, after a double tap on its row. It answers why the name was refused, or nothing. Without it the rows cannot be renamed.
    onRenameBot?: ((botId: string, name: string) => Promise<string | undefined>) | undefined;
    // Deletes a bot and answers with the server reason when it refuses.
    onDeleteBot?: ((botId: string) => Promise<string | undefined>) | undefined;
}

function initialsFromName(name: string): string {
    const words = name.trim()
        .split(/\s+/)
        .filter(word => word.length > 0);
    const initialLetters = words.slice(0, 2)
        .map(word => Array.from(word)[0] ?? '');
    const initials = initialLetters
        .join('');

    return initials.toLocaleUpperCase();
}

function BotList({ bots, selectedBotId, selectedMascotState, channels, selectedChannelId, isOpen, onSelectBot, onSelectChannel, onNewBot, onConnectApps, personName, onAccount, onPeople, onRenameBot, onDeleteBot }: BotListProps): ReactElement {
    const [renamingBotId, setRenamingBotId] = useState<string | undefined>(undefined);
    const [actionsBotId, setActionsBotId] = useState<string | undefined>(undefined);
    const [deletingBotId, setDeletingBotId] = useState<string | undefined>(undefined);
    const [deleteError, setDeleteError] = useState<string | undefined>(undefined);
    const [isDeleting, setIsDeleting] = useState(false);
    const [searchValue, setSearchValue] = useState('');
    const searchInputRef = useRef<HTMLInputElement>(null);
    const lastTapRef = useRef<Tap | undefined>(undefined);
    const className = isOpen ? 'bot-list is-open' : 'bot-list';
    const initials = personName === undefined ? '' : initialsFromName(personName);
    const accountInitials = initials.length === 0 ? 'CB' : initials;
    const normalizedSearch = searchValue.trim()
        .toLocaleLowerCase();
    const visibleBots = bots.filter(bot => bot.name.toLocaleLowerCase()
        .includes(normalizedSearch));
    const canManageBots = onRenameBot !== undefined && onDeleteBot !== undefined;
    const botToDelete = bots.find(bot => bot.id === deletingBotId);

    async function confirmDeleteBot(): Promise<void> {
        if (botToDelete === undefined || onDeleteBot === undefined) {
            return;
        }

        setIsDeleting(true);
        try {
            const error = await onDeleteBot(botToDelete.id);

            if (error !== undefined) {
                setDeleteError(error);

                return;
            }

            setDeleteError(undefined);
            setDeletingBotId(undefined);
        } catch {
            setDeleteError('The bot could not be deleted.');
        } finally {
            setIsDeleting(false);
        }
    }

    return (
        <>
            <aside className={className} aria-label="Bots">
                <div className="bot-list-header">
                    {onAccount === undefined
                        ? <span className="bot-list-header-spacer" aria-hidden="true" />
                        : <RoundButton label="Account" tone="avatar" onClick={onAccount}>{accountInitials}</RoundButton>}
                    <div className="bot-list-header-actions">
                        {onPeople === undefined
                            ? null
                            : <RoundButton label="People" onClick={onPeople}><PeopleIcon /></RoundButton>}
                        <RoundButton
                            label="Focus search"
                            onClick={() => {
                                searchInputRef.current?.focus();
                            }}
                        >
                            <SearchIcon />
                        </RoundButton>
                        <RoundButton label="New bot" onClick={onNewBot}><PlusIcon /></RoundButton>
                    </div>
                </div>
                <div className="bot-items">
                    {visibleBots.map((bot) => {
                        const isSelected = bot.id === selectedBotId;
                        const selectedClassName = isSelected ? 'bot-item is-selected' : 'bot-item';
                        const itemClassName = bot.hasUnread ? `${selectedClassName} is-unread` : selectedClassName;
                        const mascotState = isSelected ? selectedMascotState : 'idle';

                        if (renamingBotId === bot.id && onRenameBot !== undefined) {
                            return (
                                <div key={bot.id} className={`${itemClassName} is-renaming`}>
                                    <CloudMascot color={bot.mascotColor} shape={bot.mascotShape} state={mascotState} size={40} />
                                    <span className="bot-text">
                                        <span className="bot-name-line">
                                            <RenameField
                                                name={bot.name}
                                                label={`Name of ${bot.name}`}
                                                onSubmit={newName => onRenameBot(bot.id, newName)}
                                                onClose={() => {
                                                    setRenamingBotId(undefined);
                                                }}
                                            />
                                        </span>
                                        <span className="bot-preview">{bot.lastMessagePreview}</span>
                                    </span>
                                </div>
                            );
                        }

                        const botActions = canManageBots
                            ? (
                                    <BotActionsMenu
                                        botName={bot.name}
                                        isOpen={actionsBotId === bot.id}
                                        onOpenChange={(nextIsOpen) => {
                                            setActionsBotId(nextIsOpen ? bot.id : undefined);
                                        }}
                                        onRename={() => {
                                            setActionsBotId(undefined);
                                            setRenamingBotId(bot.id);
                                        }}
                                        onDelete={() => {
                                            setActionsBotId(undefined);
                                            setDeleteError(undefined);
                                            setDeletingBotId(bot.id);
                                        }}
                                    />
                                )
                            : undefined;

                        return (
                            <BotListItem
                                key={bot.id}
                                bot={bot}
                                isSelected={isSelected}
                                mascotState={mascotState}
                                actions={botActions}
                                onOpenActions={canManageBots
                                    ? () => {
                                            setActionsBotId(bot.id);
                                        }
                                    : undefined}
                                onPointerUp={(event) => {
                                    // A double tap on the row renames the bot. The first tap still selects it.
                                    const result = nextTap(lastTapRef.current, bot.id, event.timeStamp);

                                    lastTapRef.current = result.tap;

                                    if (result.isDouble && event.button === 0 && onRenameBot !== undefined) {
                                        setRenamingBotId(bot.id);
                                    }
                                }}
                                onClick={(event) => {
                                    const sourceMascot = event.currentTarget.querySelector<HTMLElement>('.cloud-mascot');
                                    // The mascot hops along the row to its right edge, then down into the chat.
                                    const rowRect = event.currentTarget.getBoundingClientRect();
                                    const rowEdge: MascotHopPoint = { x: rowRect.right - ROW_EDGE_INSET, y: rowRect.top + rowRect.height / 2 };

                                    onSelectBot(bot.id, sourceMascot, rowEdge);
                                }}
                            />
                        );
                    })}
                    {channels.length === 0
                        ? null
                        : <p className="channel-section-title">Channels</p>}
                    {channels.map((channel) => {
                        const isSelected = channel.id === selectedChannelId;
                        const itemClassName = isSelected ? 'bot-item is-selected' : 'bot-item';
                        const memberNames = channel.members.map(member => (member.isManager ? `${member.name} (manager)` : member.name));
                        const rosterText = memberNames.join(', ');

                        return (
                            <ListRow
                                key={channel.id}
                                title={channel.name}
                                description={rosterText}
                                className={`${itemClassName} channel-list-row`}
                                ariaCurrent={isSelected}
                                onClick={() => {
                                    onSelectChannel(channel.id);
                                }}
                            />
                        );
                    })}
                </div>
                <div className="bot-list-footer">
                    <RoundButton label="Connect apps" onClick={onConnectApps}><AppsGridIcon /></RoundButton>
                    <PillField leftIcon={<SearchIcon />} className="bot-list-search">
                        <input
                            ref={searchInputRef}
                            type="search"
                            className="bot-list-search-input"
                            aria-label="Search bots"
                            placeholder="Search"
                            value={searchValue}
                            onChange={(event) => {
                                setSearchValue(event.currentTarget.value);
                            }}
                        />
                    </PillField>
                </div>
            </aside>
            {botToDelete === undefined
                ? null
                : (
                        <ConfirmDialog
                            title={`Delete ${botToDelete.name}?`}
                            message={`The chats, rules, routines, webhooks, secrets, and files for ${botToDelete.name} will be removed for good.`}
                            error={deleteError}
                            isBusy={isDeleting}
                            onConfirm={() => {
                                void confirmDeleteBot();
                            }}
                            onCancel={() => {
                                setDeleteError(undefined);
                                setDeletingBotId(undefined);
                            }}
                        />
                    )}
        </>
    );
}

export { BotList };
export type { BotListProps };
