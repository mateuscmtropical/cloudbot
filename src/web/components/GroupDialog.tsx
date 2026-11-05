import { useId, useState } from 'react';
import type { ReactElement, SyntheticEvent } from 'react';

import type { ChannelSettings, ChannelSummary } from '../../shared/channelTypes.ts';
import type { BotSummary } from '../../shared/chatTypes.ts';
import { Button } from './Button.tsx';
import { CloudMascot } from './CloudMascot.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { Field } from './Field.tsx';
import { Modal } from './Modal.tsx';
import { PillField } from './PillField.tsx';
import { Select } from './Select.tsx';
import { Switch } from './Switch.tsx';

const PICKER_MASCOT_SIZE = 28;

interface GroupDialogProps {
    bots: BotSummary[];
    // The group to change. Without it the dialog makes a new one.
    group?: ChannelSummary | undefined;
    // Each answers why it was refused, or nothing.
    onSave: (settings: ChannelSettings) => Promise<string | undefined>;
    onDelete?: (() => Promise<string | undefined>) | undefined;
    onClose: () => void;
}

// Makes or changes a group of bots: its name, its members, its manager and whether it is isolated.
function GroupDialog({ bots, group, onSave, onDelete, onClose }: GroupDialogProps): ReactElement {
    const titleId = useId();
    const startingIds = group?.members.map(member => member.botId) ?? [];
    const startingManager = group?.members.find(member => member.isManager)?.botId;
    const [name, setName] = useState(group?.name ?? '');
    const [memberIds, setMemberIds] = useState(startingIds);
    const [chosenManagerId, setChosenManagerId] = useState(startingManager);
    const [isIsolated, setIsIsolated] = useState(group?.isIsolated ?? false);
    const [isBusy, setIsBusy] = useState(false);
    const [errorText, setErrorText] = useState<string | undefined>(undefined);
    const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
    const managerId = chosenManagerId !== undefined && memberIds.includes(chosenManagerId) ? chosenManagerId : memberIds[0];
    const members = bots.filter(bot => memberIds.includes(bot.id));
    const canSave = name.trim() !== '' && managerId !== undefined && !isBusy;

    function toggleMember(botId: string): void {
        setMemberIds(current => (current.includes(botId) ? current.filter(memberId => memberId !== botId) : [...current, botId]));
    }

    // A refusal stays in the dialog, so the owner can fix it there.
    async function run(action: () => Promise<string | undefined>): Promise<void> {
        setIsBusy(true);

        try {
            const problem = await action();

            setErrorText(problem);

            if (problem === undefined) {
                onClose();
            }
        } catch {
            setErrorText('Something went wrong. Try again.');
        } finally {
            setIsBusy(false);
        }
    }

    function handleSubmit(event: SyntheticEvent): void {
        event.preventDefault();

        if (canSave) {
            void run(() => onSave({ name: name.trim(), memberIds, managerId, isIsolated }));
        }
    }

    if (isConfirmingDelete && group !== undefined && onDelete !== undefined) {
        return (
            <ConfirmDialog
                title={`Delete ${group.name}?`}
                message="The group and its messages will be removed for good. The bots stay."
                error={errorText}
                isBusy={isBusy}
                onConfirm={() => {
                    void run(onDelete);
                }}
                onCancel={() => {
                    setErrorText(undefined);
                    setIsConfirmingDelete(false);
                }}
            />
        );
    }

    return (
        <Modal className="group-dialog" labelledBy={titleId} onClose={onClose}>
            <form className="group-dialog-form" onSubmit={handleSubmit}>
                <h2 id={titleId}>{group === undefined ? 'New group' : 'Edit group'}</h2>
                <Field label="Name">
                    <PillField>
                        <input
                            className="group-dialog-name"
                            maxLength={40}
                            value={name}
                            onChange={(event) => {
                                setName(event.target.value);
                            }}
                        />
                    </PillField>
                </Field>
                <fieldset className="group-dialog-bots">
                    <legend className="field-label">Bots</legend>
                    {bots.map(bot => (
                        <label key={bot.id} className="group-bot-option">
                            <input
                                type="checkbox"
                                checked={memberIds.includes(bot.id)}
                                onChange={() => {
                                    toggleMember(bot.id);
                                }}
                            />
                            <CloudMascot color={bot.mascotColor} shape={bot.mascotShape} eyes={bot.mascotEyes} state="idle" size={PICKER_MASCOT_SIZE} />
                            <span className="group-bot-name">{bot.name}</span>
                        </label>
                    ))}
                </fieldset>
                <Field label="Manager">
                    <Select
                        label="Manager"
                        disabled={members.length === 0}
                        value={managerId ?? ''}
                        onChange={(event) => {
                            setChosenManagerId(event.target.value);
                        }}
                    >
                        {members.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
                    </Select>
                </Field>
                <Switch
                    label="Isolated"
                    checked={isIsolated}
                    onChange={(event) => {
                        setIsIsolated(event.target.checked);
                    }}
                />
                <p className="group-dialog-hint">
                    Isolated bots message only the bots in this group, and other bots cannot message them. This limits which bots can message each other. It is not a security boundary, since all your bots share one system user.
                </p>
                {errorText === undefined ? null : <p className="confirm-dialog-error" role="alert">{errorText}</p>}
                <div className="confirm-dialog-actions">
                    {onDelete === undefined
                        ? null
                        : (
                                <Button
                                    tone="danger"
                                    className="group-dialog-delete"
                                    disabled={isBusy}
                                    onClick={() => {
                                        setErrorText(undefined);
                                        setIsConfirmingDelete(true);
                                    }}
                                >
                                    Delete
                                </Button>
                            )}
                    <Button disabled={isBusy} onClick={onClose}>Cancel</Button>
                    <Button type="submit" tone="selected" disabled={!canSave}>{isBusy ? 'Saving…' : 'Save'}</Button>
                </div>
            </form>
        </Modal>
    );
}

export { GroupDialog };
export type { GroupDialogProps };
