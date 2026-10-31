import { useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';

import type { BotSummary } from '../../shared/chatTypes.ts';
import { MASCOT_COLORS, MASCOT_COLOR_NAMES, MASCOT_SHAPES } from '../../shared/mascot.ts';
import type { MascotChoice, MascotColorName, MascotShape } from '../../shared/mascot.ts';
import { NotificationsSection } from './AccountPanel.tsx';
import type { PushControls } from './AccountPanel.tsx';
import { CloudMascot } from './CloudMascot.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { AppsGridIcon, BackIcon, MoreIcon, MonitorIcon } from './icons.tsx';
import { ListGroup } from './ListGroup.tsx';
import { ListRow } from './ListRow.tsx';
import { RoundButton } from './RoundButton.tsx';

// Each handler answers the reason the change was refused, or nothing when it was saved.
type BotChangeHandler<Change> = (botId: string, change: Change) => Promise<string | undefined>;

interface BotProfilePanelProps {
    bot: BotSummary;
    onClose: () => void;
    onRenameBot: BotChangeHandler<string>;
    onChangeMascot: BotChangeHandler<MascotChoice>;
    onDeleteBot: (botId: string) => Promise<string | undefined>;
    onOpenConnectApps: () => void;
    onOpenScreen: () => void;
    computerState?: string | undefined;
    pushControls?: PushControls | undefined;
}

interface BotDraft {
    name: string;
    color: MascotColorName;
    shape: MascotShape;
}

interface BotEditFormProps {
    bot: BotSummary;
    draft: BotDraft;
    onDraftChange: (draft: BotDraft) => void;
    onRenameBot: BotChangeHandler<string>;
    onChangeMascot: BotChangeHandler<MascotChoice>;
    onDone: () => void;
}

// The name, the color and the shape change together. Save writes only what changed. Cancel or Escape keeps the bot as it was.
function BotEditForm({ bot, draft, onDraftChange, onRenameBot, onChangeMascot, onDone }: BotEditFormProps): ReactElement {
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [isSaving, setIsSaving] = useState(false);

    async function save(): Promise<void> {
        const name = draft.name.trim();
        const isNameChanged = name !== bot.name;
        const isMascotChanged = draft.color !== bot.mascotColor || draft.shape !== bot.mascotShape;

        setIsSaving(true);
        setProblem(undefined);

        const nameProblem = isNameChanged ? await onRenameBot(bot.id, name) : undefined;
        const mascotProblem = nameProblem === undefined && isMascotChanged
            ? await onChangeMascot(bot.id, { color: draft.color, shape: draft.shape })
            : undefined;
        const saveProblem = nameProblem ?? mascotProblem;

        setIsSaving(false);

        if (saveProblem === undefined) {
            onDone();

            return;
        }

        setProblem(saveProblem);
    }

    function handleKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
        if (event.key === 'Escape') {
            onDone();
        }
    }

    return (
        <form
            className="bot-edit-form"
            aria-label={`Edit ${bot.name}`}
            onKeyDown={handleKeyDown}
            onSubmit={(event) => {
                event.preventDefault();

                if (!isSaving) {
                    void save();
                }
            }}
        >
            <label className="bot-edit-field">
                <span>Name</span>
                <input
                    type="text"
                    className="rename-input"
                    value={draft.name}
                    maxLength={40}
                    required
                    autoFocus
                    readOnly={isSaving}
                    onChange={(event) => {
                        onDraftChange({ ...draft, name: event.target.value });
                        setProblem(undefined);
                    }}
                />
            </label>
            <fieldset className="bot-edit-choices">
                <legend>Color</legend>
                {MASCOT_COLOR_NAMES.map(colorName => (
                    <label key={colorName} className="bot-edit-choice" title={colorName}>
                        <input
                            type="radio"
                            name="mascot-color"
                            aria-label={colorName}
                            checked={draft.color === colorName}
                            onChange={() => {
                                onDraftChange({ ...draft, color: colorName });
                            }}
                        />
                        <span className="bot-edit-swatch" style={{ background: MASCOT_COLORS[colorName] }} aria-hidden="true" />
                    </label>
                ))}
            </fieldset>
            <fieldset className="bot-edit-choices">
                <legend>Shape</legend>
                {MASCOT_SHAPES.map(shapeName => (
                    <label key={shapeName} className="bot-edit-choice" title={shapeName}>
                        <input
                            type="radio"
                            name="mascot-shape"
                            aria-label={shapeName}
                            checked={draft.shape === shapeName}
                            onChange={() => {
                                onDraftChange({ ...draft, shape: shapeName });
                            }}
                        />
                        <CloudMascot color={draft.color} shape={shapeName} state="idle" size={36} />
                    </label>
                ))}
            </fieldset>
            {problem === undefined ? null : <p className="bot-edit-problem" role="alert">{problem}</p>}
            <div className="bot-edit-actions">
                <button type="button" className="choice-button" disabled={isSaving} onClick={onDone}>Cancel</button>
                <button type="submit" className="choice-button is-selected" disabled={isSaving}>{isSaving ? 'Saving…' : 'Save'}</button>
            </div>
        </form>
    );
}

function BotProfilePanel({ bot, onClose, onRenameBot, onChangeMascot, onDeleteBot, onOpenConnectApps, onOpenScreen, computerState, pushControls }: BotProfilePanelProps): ReactElement {
    const [draft, setDraft] = useState<BotDraft | undefined>(undefined);
    const [isMoreOpen, setIsMoreOpen] = useState(false);
    const [isDeleteOpen, setIsDeleteOpen] = useState(false);
    const [deleteError, setDeleteError] = useState<string | undefined>(undefined);
    const [isDeleting, setIsDeleting] = useState(false);
    // While editing, the mascot shows the color and the shape that Save would keep.
    const shownColor = draft?.color ?? bot.mascotColor;
    const shownShape = draft?.shape ?? bot.mascotShape;

    async function confirmDelete(): Promise<void> {
        setIsDeleting(true);

        const refusal = await onDeleteBot(bot.id);

        setIsDeleting(false);

        if (refusal === undefined) {
            setIsDeleteOpen(false);
            onClose();

            return;
        }

        setDeleteError(refusal);
    }

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
                                        className="is-danger"
                                        onClick={() => {
                                            setIsMoreOpen(false);
                                            setDeleteError(undefined);
                                            setIsDeleteOpen(true);
                                        }}
                                    >
                                        Delete bot
                                    </button>
                                </div>
                            )
                        : null}
                </div>
            </header>

            <div className="bot-profile-content">
                <div className="bot-profile-hero">
                    <CloudMascot color={shownColor} shape={shownShape} state="idle" size={90} />
                    {draft === undefined
                        ? (
                                <>
                                    <h1 id="bot-profile-name">{bot.name}</h1>
                                    <button
                                        type="button"
                                        className="bot-profile-edit"
                                        onClick={() => {
                                            setDraft({ name: bot.name, color: bot.mascotColor, shape: bot.mascotShape });
                                        }}
                                    >
                                        Edit
                                    </button>
                                </>
                            )
                        : (
                                <BotEditForm
                                    bot={bot}
                                    draft={draft}
                                    onDraftChange={setDraft}
                                    onRenameBot={onRenameBot}
                                    onChangeMascot={onChangeMascot}
                                    onDone={() => {
                                        setDraft(undefined);
                                    }}
                                />
                            )}
                </div>

                <ListGroup ariaLabel="Bot settings">
                    <ListRow title="Connected apps" leadingIcon={<AppsGridIcon />} onClick={onOpenConnectApps} chevron />
                    <ListRow title="Computer" leadingIcon={<MonitorIcon />} value={computerState} onClick={onOpenScreen} chevron />
                </ListGroup>

                <NotificationsSection pushControls={pushControls} />
            </div>

            {isDeleteOpen
                ? (
                        <ConfirmDialog
                            title={`Delete ${bot.name}?`}
                            message={`The chats, rules, routines, webhooks, secrets, and files for ${bot.name} will be removed for good.`}
                            error={deleteError}
                            isBusy={isDeleting}
                            onConfirm={() => {
                                void confirmDelete();
                            }}
                            onCancel={() => {
                                setIsDeleteOpen(false);
                            }}
                        />
                    )
                : null}
        </section>
    );
}

export { BotProfilePanel };
export type { BotProfilePanelProps };
