import { useState } from 'react';
import type { ReactElement } from 'react';

import type { BotSummary } from '../../shared/chatTypes.ts';
import { NotificationsSection } from './AccountPanel.tsx';
import type { PushControls } from './AccountPanel.tsx';
import { CloudMascot } from './CloudMascot.tsx';
import { AppsGridIcon, BackIcon, MoreIcon, MonitorIcon } from './icons.tsx';
import { ListGroup } from './ListGroup.tsx';
import { ListRow } from './ListRow.tsx';
import { RenameField } from './RenameField.tsx';
import { RoundButton } from './RoundButton.tsx';

interface BotProfilePanelProps {
    bot: BotSummary;
    onClose: () => void;
    onRenameBot: (botId: string, name: string) => Promise<string | undefined>;
    onOpenConnectApps: () => void;
    onOpenScreen: () => void;
    computerState?: string | undefined;
    pushControls?: PushControls | undefined;
}

function BotProfilePanel({ bot, onClose, onRenameBot, onOpenConnectApps, onOpenScreen, computerState, pushControls }: BotProfilePanelProps): ReactElement {
    const [isRenaming, setIsRenaming] = useState(false);
    const [isMoreOpen, setIsMoreOpen] = useState(false);

    return (
        <section className="bot-profile-panel" aria-label={`${bot.name} profile`}>
            <header className="bot-profile-header">
                <RoundButton label="Back to chat" onClick={onClose}><BackIcon /></RoundButton>
                <div className="bot-profile-more-wrap">
                    <RoundButton label="More options" onClick={() => { setIsMoreOpen(current => !current); }}><MoreIcon /></RoundButton>
                    {isMoreOpen
                        ? (
                                <div className="bot-profile-more-menu">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setIsMoreOpen(false);
                                            setIsRenaming(true);
                                        }}
                                    >
                                        Rename bot
                                    </button>
                                </div>
                            )
                        : null}
                </div>
            </header>

            <div className="bot-profile-content">
                <div className="bot-profile-hero">
                    <CloudMascot color={bot.mascotColor} shape={bot.mascotShape} state="idle" size={90} />
                    {isRenaming
                        ? (
                                <RenameField
                                    name={bot.name}
                                    label={`Name of ${bot.name}`}
                                    className="bot-profile-name-input"
                                    onSubmit={name => onRenameBot(bot.id, name)}
                                    onClose={() => { setIsRenaming(false); }}
                                />
                            )
                        : <h1 id="bot-profile-name">{bot.name}</h1>}
                    <button type="button" className="bot-profile-edit" onClick={() => { setIsRenaming(true); }}>Edit</button>
                </div>

                <ListGroup ariaLabel="Bot settings">
                    <ListRow title="Connected apps" leadingIcon={<AppsGridIcon />} onClick={onOpenConnectApps} chevron />
                    <ListRow title="Computer" leadingIcon={<MonitorIcon />} value={computerState} onClick={onOpenScreen} chevron />
                </ListGroup>

                <div className="bot-profile-notifications">
                    <NotificationsSection pushControls={pushControls} />
                </div>
            </div>
        </section>
    );
}

export { BotProfilePanel };
export type { BotProfilePanelProps };
