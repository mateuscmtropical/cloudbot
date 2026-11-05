import { useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';

import type { BotSummary } from '../../shared/chatTypes.ts';
import { MASCOT_BOLTS, MASCOT_COLORS, MASCOT_COLOR_NAMES, MASCOT_EYES, MASCOT_PRESETS, MASCOT_SHAPES, MASCOT_WEATHERS, readShownWeather } from '../../shared/mascot.ts';
import type { MascotLook } from '../../shared/mascot.ts';
import { NotificationsSection } from './AccountPanel.tsx';
import type { PushControls } from './AccountPanel.tsx';
import { Button } from './Button.tsx';
import { CloudMascot } from './CloudMascot.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { Field } from './Field.tsx';
import { AppsGridIcon, BackIcon, LibraryIcon, MoreIcon, MonitorIcon, TrashIcon, WebhookIcon } from './icons.tsx';
import { ListGroup } from './ListGroup.tsx';
import { ListRow } from './ListRow.tsx';
import { MemoryPanel } from './MemoryPanel.tsx';
import { WebhooksPanel } from './WebhooksPanel.tsx';
import { PanelHeader } from './PanelHeader.tsx';
import { PopoverMenu, PopoverMenuItem } from './PopoverMenu.tsx';

// Each handler answers the reason the change was refused, or nothing when it was saved.
type BotChangeHandler<Change> = (botId: string, change: Change) => Promise<string | undefined>;

interface BotProfilePanelProps {
    bot: BotSummary;
    onClose: () => void;
    onRenameBot: BotChangeHandler<string>;
    onChangeMascot: BotChangeHandler<MascotLook>;
    onDeleteBot: (botId: string) => Promise<string | undefined>;
    onOpenConnectApps: () => void;
    onOpenScreen: () => void;
    computerState?: string | undefined;
    pushControls?: PushControls | undefined;
}

// Lightning shows only in a sneeze, so a preview starts just before one.
const PREVIEW_SNEEZE_DELAY_S = -11;

interface BotDraft extends MascotLook {
    name: string;
}

interface BotEditFormProps {
    bot: BotSummary;
    draft: BotDraft;
    onDraftChange: (draft: BotDraft) => void;
    onRenameBot: BotChangeHandler<string>;
    onChangeMascot: BotChangeHandler<MascotLook>;
    onDone: () => void;
}

// The name and the look change together. A ready look from the mascot sheet sets the color, the shape and the eyes at once. Save writes only what changed. Cancel or Escape keeps the bot as it was.
function BotEditForm({ bot, draft, onDraftChange, onRenameBot, onChangeMascot, onDone }: BotEditFormProps): ReactElement {
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [isSaving, setIsSaving] = useState(false);

    async function save(): Promise<void> {
        const name = draft.name.trim();
        const isNameChanged = name !== bot.name;
        const isMascotChanged = draft.color !== bot.mascotColor || draft.shape !== bot.mascotShape || draft.eyes !== bot.mascotEyes || draft.weather !== bot.mascotWeather || draft.bolt !== bot.mascotBolt;

        setIsSaving(true);
        setProblem(undefined);

        const nameProblem = isNameChanged ? await onRenameBot(bot.id, name) : undefined;
        const mascotProblem = nameProblem === undefined && isMascotChanged
            ? await onChangeMascot(bot.id, { color: draft.color, shape: draft.shape, eyes: draft.eyes, weather: draft.weather, bolt: draft.bolt })
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
            <Field label="Name">
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
            </Field>
            <fieldset className="bot-edit-choices">
                <legend>Look</legend>
                {MASCOT_PRESETS.map(preset => (
                    <label key={preset.label} className="bot-edit-choice" title={preset.label}>
                        <input
                            type="radio"
                            name="mascot-look"
                            aria-label={preset.label}
                            checked={draft.color === preset.color && draft.shape === preset.shape && draft.eyes === preset.eyes}
                            onChange={() => {
                                onDraftChange({ ...draft, color: preset.color, shape: preset.shape, eyes: preset.eyes });
                            }}
                        />
                        <CloudMascot color={preset.color} shape={preset.shape} eyes={preset.eyes} state="idle" size={36} />
                    </label>
                ))}
            </fieldset>
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
                        <CloudMascot color={draft.color} shape={shapeName} eyes={draft.eyes} state="idle" size={36} />
                    </label>
                ))}
            </fieldset>
            <fieldset className="bot-edit-choices">
                <legend>Eyes</legend>
                {MASCOT_EYES.map(eyesName => (
                    <label key={eyesName} className="bot-edit-choice" title={eyesName}>
                        <input
                            type="radio"
                            name="mascot-eyes"
                            aria-label={eyesName}
                            checked={draft.eyes === eyesName}
                            onChange={() => {
                                onDraftChange({ ...draft, eyes: eyesName });
                            }}
                        />
                        <CloudMascot color={draft.color} shape={draft.shape} eyes={eyesName} state="idle" size={36} />
                    </label>
                ))}
            </fieldset>
            <fieldset className="bot-edit-choices">
                <legend>Weather</legend>
                {MASCOT_WEATHERS.map(weatherName => (
                    <label key={weatherName} className="bot-edit-choice" title={weatherName === 'auto' ? 'By shape' : weatherName}>
                        <input
                            type="radio"
                            name="mascot-weather"
                            aria-label={weatherName === 'auto' ? 'By shape' : weatherName}
                            checked={draft.weather === weatherName}
                            onChange={() => {
                                onDraftChange({ ...draft, weather: weatherName });
                            }}
                        />
                        <CloudMascot color={draft.color} shape={draft.shape} eyes={draft.eyes} state="idle" size={36} mood="weather" moodDelaySeconds={PREVIEW_SNEEZE_DELAY_S} weather={weatherName} bolt={draft.bolt} />
                    </label>
                ))}
            </fieldset>
            {readShownWeather(draft.weather, draft.shape) === 'lightning'
                ? (
                        <fieldset className="bot-edit-choices">
                            <legend>Lightning goes</legend>
                            {MASCOT_BOLTS.map(boltName => (
                                <label key={boltName} className="bot-edit-choice" title={boltName}>
                                    <input
                                        type="radio"
                                        name="mascot-bolt"
                                        aria-label={boltName}
                                        checked={draft.bolt === boltName}
                                        onChange={() => {
                                            onDraftChange({ ...draft, bolt: boltName });
                                        }}
                                    />
                                    <CloudMascot color={draft.color} shape={draft.shape} eyes={draft.eyes} state="idle" size={36} mood="weather" moodDelaySeconds={PREVIEW_SNEEZE_DELAY_S} weather="lightning" bolt={boltName} />
                                </label>
                            ))}
                        </fieldset>
                    )
                : null}
            {' '}
            {problem === undefined ? null : <p className="bot-edit-problem" role="alert">{problem}</p>}
            <div className="bot-edit-actions">
                <Button disabled={isSaving} onClick={onDone}>Cancel</Button>
                <Button type="submit" tone="selected" disabled={isSaving}>{isSaving ? 'Saving…' : 'Save'}</Button>
            </div>
        </form>
    );
}

function BotProfilePanel({ bot, onClose, onRenameBot, onChangeMascot, onDeleteBot, onOpenConnectApps, onOpenScreen, computerState, pushControls }: BotProfilePanelProps): ReactElement {
    const [draft, setDraft] = useState<BotDraft | undefined>(undefined);
    const [isDeleteOpen, setIsDeleteOpen] = useState(false);
    const [deleteError, setDeleteError] = useState<string | undefined>(undefined);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isMemoryOpen, setIsMemoryOpen] = useState(false);
    const [isWebhooksOpen, setIsWebhooksOpen] = useState(false);
    // While editing, the mascot shows the look that Save would keep.
    const shownColor = draft?.color ?? bot.mascotColor;
    const shownShape = draft?.shape ?? bot.mascotShape;
    const shownEyes = draft?.eyes ?? bot.mascotEyes;
    const shownWeather = draft?.weather ?? bot.mascotWeather;
    const shownBolt = draft?.bolt ?? bot.mascotBolt;

    if (isMemoryOpen) {
        return (
            <MemoryPanel
                bot={bot}
                onClose={() => {
                    setIsMemoryOpen(false);
                }}
            />
        );
    }

    if (isWebhooksOpen) {
        return (
            <WebhooksPanel
                bot={bot}
                onClose={() => {
                    setIsWebhooksOpen(false);
                }}
            />
        );
    }

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
            <PanelHeader className="bot-profile-header" closeLabel="Back to chat" closeIcon={<BackIcon />} onClose={onClose}>
                <PopoverMenu label="Bot options" triggerLabel="More options" triggerIcon={<MoreIcon />} placement="below-end">
                    {close => (
                        <PopoverMenuItem
                            label="Delete bot"
                            icon={<TrashIcon />}
                            tone="danger"
                            close={close}
                            onSelect={() => {
                                setDeleteError(undefined);
                                setIsDeleteOpen(true);
                            }}
                        />
                    )}
                </PopoverMenu>
            </PanelHeader>

            <div className="bot-profile-content">
                <div className="bot-profile-hero">
                    <CloudMascot color={shownColor} shape={shownShape} eyes={shownEyes} state="idle" size={90} isActive mood={draft === undefined ? undefined : 'weather'} moodDelaySeconds={PREVIEW_SNEEZE_DELAY_S} weather={shownWeather} bolt={shownBolt} />
                    {draft === undefined
                        ? (
                                <>
                                    <h1 id="bot-profile-name">{bot.name}</h1>
                                    <Button
                                        className="bot-profile-edit"
                                        onClick={() => {
                                            setDraft({ name: bot.name, color: bot.mascotColor, shape: bot.mascotShape, eyes: bot.mascotEyes, weather: bot.mascotWeather, bolt: bot.mascotBolt });
                                        }}
                                    >
                                        Edit
                                    </Button>
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
                    <ListRow
                        title="Memory"
                        leadingIcon={<LibraryIcon />}
                        onClick={() => {
                            setIsMemoryOpen(true);
                        }}
                        chevron
                    />
                    <ListRow
                        title="Webhooks"
                        leadingIcon={<WebhookIcon />}
                        onClick={() => {
                            setIsWebhooksOpen(true);
                        }}
                        chevron
                    />
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
