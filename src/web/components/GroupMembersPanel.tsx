import { useEffect, useState } from 'react';
import type { ReactElement, SyntheticEvent } from 'react';

import type { GroupRole } from '../../shared/peopleTypes.ts';
import { RequestFailedError } from '../apiClient.ts';
import { changeGroupMember, getGroupMembers } from '../peopleClient.ts';
import type { ChangeGroupMemberPayload, GroupMembersView } from '../peopleClient.ts';
import { Button } from './Button.tsx';
import { Field } from './Field.tsx';
import { PanelHeader } from './PanelHeader.tsx';

interface GroupMembersPanelProps {
    onClose: () => void;
}

const ROLE_LABELS: Record<GroupRole, string> = {
    owner: 'Owner',
    admin: 'Admin',
    member: 'Member',
};

function describeProblem(error: unknown): string {
    return error instanceof RequestFailedError && error.serverMessage !== undefined ? error.serverMessage : 'The request failed. Try again.';
}

// The people of a shared group. Everyone sees them. An admin or the owner adds, removes and sets roles.
function GroupMembersPanel({ onClose }: GroupMembersPanelProps): ReactElement {
    const [view, setView] = useState<GroupMembersView | undefined>(undefined);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [isWorking, setIsWorking] = useState(false);
    const [newPerson, setNewPerson] = useState('');

    useEffect(() => {
        let isCurrent = true;

        getGroupMembers()
            .then((loaded) => {
                if (isCurrent) {
                    setView(loaded);
                }
            })
            .catch((error: unknown) => {
                if (isCurrent) {
                    const message = describeProblem(error);

                    setProblem(message);
                }
            });

        return () => {
            isCurrent = false;
        };
    }, []);

    function change(payload: ChangeGroupMemberPayload): void {
        setIsWorking(true);
        setProblem(undefined);
        changeGroupMember(payload)
            .then((changed) => {
                setView(changed);
                setNewPerson('');
            })
            .catch((error: unknown) => {
                const message = describeProblem(error);

                setProblem(message);
            })
            .finally(() => {
                setIsWorking(false);
            });
    }

    function handleAdd(event: SyntheticEvent<HTMLFormElement>): void {
        event.preventDefault();
        change({ action: 'set', person: newPerson, role: 'member' });
    }

    const canManage = view?.canManage === true;
    const addable = view?.addable ?? [];

    return (
        <section className="people-panel" aria-labelledby="group-members-title">
            <PanelHeader
                className="people-panel-header settings-page-header"
                closeLabel="Close members panel"
                onClose={onClose}
                title="Members"
                titleId="group-members-title"
                description="The people who work in this group."
            />

            {problem === undefined ? null : <p className="people-problem" role="alert">{problem}</p>}

            {canManage && addable.length > 0
                ? (
                        <form className="setup-card people-add-form" onSubmit={handleAdd}>
                            <h2>Add person</h2>
                            <div className="setup-form">
                                <Field label="Person">
                                    <select value={newPerson} onChange={(event) => { setNewPerson(event.currentTarget.value); }}>
                                        <option value="">Choose a person</option>
                                        {addable.map(name => <option key={name} value={name}>{name}</option>)}
                                    </select>
                                </Field>
                                <Button type="submit" disabled={isWorking || newPerson === ''}>Add person</Button>
                            </div>
                        </form>
                    )
                : null}

            <div className="people-list" aria-live="polite">
                {view === undefined && problem === undefined ? <p>Loading members...</p> : null}
                {view?.members.map((member) => {
                    const isGroupOwner = member.role === 'owner';
                    const isYou = member.name === view.you.name;
                    const otherRole = member.role === 'admin' ? 'member' : 'admin';

                    return (
                        <article className="setup-card people-person" key={member.name}>
                            <div className="people-person-heading">
                                <h2>{isYou ? `${member.name} (you)` : member.name}</h2>
                                <div className="people-chips">
                                    <span className="people-chip">{ROLE_LABELS[member.role]}</span>
                                </div>
                            </div>
                            {canManage && !isGroupOwner
                                ? (
                                        <div className="choice-buttons">
                                            <Button disabled={isWorking} onClick={() => { change({ action: 'set', person: member.name, role: otherRole }); }}>
                                                {otherRole === 'admin' ? 'Make admin' : 'Make member'}
                                            </Button>
                                            <Button disabled={isWorking} onClick={() => { change({ action: 'remove', person: member.name }); }}>Remove</Button>
                                        </div>
                                    )
                                : null}
                        </article>
                    );
                })}
            </div>
        </section>
    );
}

export { GroupMembersPanel };
