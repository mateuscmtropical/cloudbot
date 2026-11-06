import { useState } from 'react';
import type { ReactElement } from 'react';

import type { SharedGroup } from '../../shared/peopleTypes.ts';
import { RequestFailedError } from '../apiClient.ts';
import { deleteGroup } from '../peopleClient.ts';
import { Button } from './Button.tsx';
import { Field } from './Field.tsx';

interface SharedGroupsSectionProps {
    groups: SharedGroup[];
    onDeleted: (name: string) => void;
}

// The shared groups on this server, for the owner. Deleting one takes its bots and chats with it.
function SharedGroupsSection({ groups, onDeleted }: SharedGroupsSectionProps): ReactElement | null {
    const [deletingName, setDeletingName] = useState<string | undefined>(undefined);
    const [confirmation, setConfirmation] = useState('');
    const [isWorking, setIsWorking] = useState(false);
    const [problem, setProblem] = useState<string | undefined>(undefined);

    if (groups.length === 0) {
        return null;
    }

    function handleDelete(name: string): void {
        setIsWorking(true);
        setProblem(undefined);
        deleteGroup(name)
            .then(() => {
                setDeletingName(undefined);
                setConfirmation('');
                onDeleted(name);
            })
            .catch((error: unknown) => {
                const message = error instanceof RequestFailedError && error.serverMessage !== undefined ? error.serverMessage : `Could not delete ${name}.`;

                setProblem(message);
            })
            .finally(() => {
                setIsWorking(false);
            });
    }

    return (
        <div className="people-list" aria-label="Shared groups">
            <h2>Shared groups</h2>
            {problem === undefined ? null : <p className="people-problem" role="alert">{problem}</p>}
            {groups.map((group) => {
                const isConfirming = deletingName === group.name;
                const memberNames = group.members.map(member => member.name);

                return (
                    <article className="setup-card people-person" key={group.name}>
                        <div className="people-person-heading">
                            <h2>{group.name}</h2>
                        </div>
                        <dl className="people-details">
                            <div>
                                <dt>Members</dt>
                                <dd>{memberNames.join(', ')}</dd>
                            </div>
                        </dl>
                        <div className="choice-buttons">
                            <Button
                                disabled={isWorking}
                                onClick={() => {
                                    setDeletingName(isConfirming ? undefined : group.name);
                                    setConfirmation('');
                                }}
                            >
                                {isConfirming ? 'Cancel delete' : 'Delete group'}
                            </Button>
                        </div>
                        {isConfirming
                            ? (
                                    <div className="people-delete-confirmation">
                                        <Field label={`Type ${group.name} to delete the group with its bots and chats`}>
                                            <input autoComplete="off" value={confirmation} onChange={(event) => { setConfirmation(event.currentTarget.value); }} />
                                        </Field>
                                        <Button disabled={confirmation !== group.name || isWorking} onClick={() => { handleDelete(group.name); }}>Confirm delete</Button>
                                    </div>
                                )
                            : null}
                    </article>
                );
            })}
        </div>
    );
}

export { SharedGroupsSection };
