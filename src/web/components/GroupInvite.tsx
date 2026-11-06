import type { ReactElement } from 'react';

import type { BotSummary } from '../../shared/chatTypes.ts';
import type { SharedGroup } from '../../shared/peopleTypes.ts';
import { RequestFailedError } from '../apiClient.ts';
import { addGroup, sendBotToGroup, setGroupMemberRole } from '../peopleClient.ts';
import { Field } from './Field.tsx';

type BotChoice = 'keep' | 'copy' | 'move';

// What the owner picked under Add person. An empty group means no group. NEW_GROUP means the new group name is used.
interface GroupInviteChoice {
    group: string;
    newGroupName: string;
    botChoices: Record<string, BotChoice>;
}

interface GroupInviteFieldsProps {
    groups: SharedGroup[];
    bots: BotSummary[];
    choice: GroupInviteChoice;
    onChange: (choice: GroupInviteChoice) => void;
}

const NEW_GROUP = '__new__';
const EMPTY_GROUP_INVITE: GroupInviteChoice = { group: '', newGroupName: '', botChoices: {} };
const BOT_CHOICE_LABELS: Record<BotChoice, string> = {
    keep: 'Keep only here',
    copy: 'Copy to the group',
    move: 'Move to the group',
};
const BOT_CHOICES: BotChoice[] = ['keep', 'copy', 'move'];

function GroupInviteFields({ groups, bots, choice, onChange }: GroupInviteFieldsProps): ReactElement {
    const hasGroup = choice.group !== '';

    return (
        <>
            <Field label="Invite to a group">
                <select value={choice.group} onChange={(event) => { onChange({ ...choice, group: event.currentTarget.value }); }}>
                    <option value="">No group</option>
                    {groups.map(group => <option key={group.name} value={group.name}>{group.name}</option>)}
                    <option value={NEW_GROUP}>New group</option>
                </select>
            </Field>
            {choice.group === NEW_GROUP
                ? (
                        <Field label="Group name">
                            <input autoComplete="off" value={choice.newGroupName} onChange={(event) => { onChange({ ...choice, newGroupName: event.currentTarget.value }); }} />
                        </Field>
                    )
                : null}
            {hasGroup && bots.length > 0
                ? (
                        <fieldset className="group-invite-bots">
                            <legend>Your bots in the group. A new group starts with only its own first bot.</legend>
                            {bots.map(bot => (
                                <Field key={bot.id} label={bot.name}>
                                    <select
                                        value={choice.botChoices[bot.id] ?? 'keep'}
                                        onChange={(event) => {
                                            const picked = BOT_CHOICES.find(candidate => candidate === event.currentTarget.value) ?? 'keep';

                                            onChange({ ...choice, botChoices: { ...choice.botChoices, [bot.id]: picked } });
                                        }}
                                    >
                                        {BOT_CHOICES.map(option => <option key={option} value={option}>{BOT_CHOICE_LABELS[option]}</option>)}
                                    </select>
                                </Field>
                            ))}
                        </fieldset>
                    )
                : null}
        </>
    );
}

// Puts the new person in the group, making the group first when asked, then sends the chosen bots one by one.
// Returns a line for each thing that went wrong, so the owner sees what is left to do.
async function runGroupInvite(personName: string, choice: GroupInviteChoice, bots: BotSummary[]): Promise<string[]> {
    if (choice.group === '') {
        return [];
    }

    const isNew = choice.group === NEW_GROUP;
    const created = isNew ? await addGroup(choice.newGroupName) : undefined;
    const groupName = created?.name ?? choice.group;

    await setGroupMemberRole(groupName, personName, 'member');

    const chosenBots = bots.filter(bot => (choice.botChoices[bot.id] ?? 'keep') !== 'keep');
    const sends = chosenBots.map(async (bot) => {
        const mode = choice.botChoices[bot.id] === 'move' ? 'move' : 'copy';

        try {
            const sent = await sendBotToGroup(groupName, bot.id, mode);

            return sent.problem === undefined ? undefined : `${bot.name}: ${sent.problem}`;
        } catch (error: unknown) {
            const reason = error instanceof RequestFailedError && error.serverMessage !== undefined ? error.serverMessage : 'It could not be sent.';

            return `${bot.name} did not reach the group. ${reason}`;
        }
    });
    const outcomes = await Promise.all(sends);

    return outcomes.filter((line): line is string => line !== undefined);
}

export { EMPTY_GROUP_INVITE, GroupInviteFields, NEW_GROUP, runGroupInvite };
export type { GroupInviteChoice };
