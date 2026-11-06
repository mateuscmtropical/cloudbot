import { useEffect, useState } from 'react';
import type { ReactElement, SyntheticEvent } from 'react';

import type { BotSummary } from '../../shared/chatTypes.ts';
import type { Person, PersonWithPassword, SharedGroup } from '../../shared/peopleTypes.ts';
import { RequestFailedError } from '../apiClient.ts';
import { addPerson, deactivatePerson, deletePerson, listGroups, listPeople, reactivatePerson, resetPersonPassword } from '../peopleClient.ts';
import { Button } from './Button.tsx';
import { Field } from './Field.tsx';
import { EMPTY_GROUP_INVITE, GroupInviteFields, NEW_GROUP, runGroupInvite } from './GroupInvite.tsx';
import type { GroupInviteChoice } from './GroupInvite.tsx';
import { PanelHeader } from './PanelHeader.tsx';

interface PeoplePanelProps {
    onClose: () => void;
    // The owner's bots, which a group invite can copy or move.
    bots?: BotSummary[];
    // Called after an invite, since a moved bot leaves this CloudBot.
    onBotsChanged?: () => void;
}

interface OneTimeCredential {
    address: string;
    password: string;
}

const INSTANCE_LABELS: Record<Person['instance'], string> = {
    missing: 'Not created',
    stopped: 'Stopped',
    starting: 'Starting',
    running: 'Running',
};

function getErrorText(error: unknown, fallback: string): string {
    if (error instanceof RequestFailedError && error.serverMessage !== undefined) {
        return error.serverMessage;
    }

    return fallback;
}

function toCredential(person: PersonWithPassword): OneTimeCredential {
    return { address: person.person.address, password: person.password };
}

function replacePerson(people: Person[], updatedPerson: Person): Person[] {
    return people.map(person => person.name === updatedPerson.name ? updatedPerson : person);
}

function PeoplePanel({ onClose, bots = [], onBotsChanged }: PeoplePanelProps): ReactElement {
    const [people, setPeople] = useState<Person[]>([]);
    const [groups, setGroups] = useState<SharedGroup[]>([]);
    const [invite, setInvite] = useState<GroupInviteChoice>(EMPTY_GROUP_INVITE);
    const [name, setName] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [isWorking, setIsWorking] = useState(false);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [credential, setCredential] = useState<OneTimeCredential | undefined>(undefined);
    const [deleteName, setDeleteName] = useState<string | undefined>(undefined);
    const [deleteConfirmation, setDeleteConfirmation] = useState('');
    const [copyProblem, setCopyProblem] = useState<string | undefined>(undefined);

    useEffect(() => {
        let isCurrent = true;

        listPeople()
            .then((listedPeople) => {
                if (isCurrent) {
                    setPeople(listedPeople);
                    setProblem(undefined);
                }
            })
            .catch((error: unknown) => {
                if (isCurrent) {
                    const errorText = getErrorText(error, 'Could not load people.');

                    setProblem(errorText);
                }
            })
            .finally(() => {
                if (isCurrent) {
                    setIsLoading(false);
                }
            });

        return () => {
            isCurrent = false;
        };
    }, []);

    useEffect(() => {
        let isCurrent = true;

        // A hub without groups, or an older one, leaves the group choice with only a new group.
        listGroups()
            .then((listedGroups) => {
                if (isCurrent) {
                    setGroups(listedGroups);
                }
            })
            .catch(() => undefined);

        return () => {
            isCurrent = false;
        };
    }, []);

    async function addWithInvite(): Promise<void> {
        const createdPerson = await addPerson(name);

        setPeople((currentPeople) => {
            const remainingPeople = currentPeople.filter(person => person.name !== createdPerson.person.name);

            return [createdPerson.person, ...remainingPeople];
        });
        const oneTimeCredential = toCredential(createdPerson);

        setCredential(oneTimeCredential);
        setName('');

        try {
            const inviteProblems = await runGroupInvite(createdPerson.person.name, invite, bots);

            setProblem(inviteProblems.length === 0 ? undefined : inviteProblems.join(' '));
        } catch (error: unknown) {
            const errorText = getErrorText(error, 'The person was added, but not to the group.');

            setProblem(errorText);
        }

        setInvite(EMPTY_GROUP_INVITE);
        onBotsChanged?.();
        const refreshedGroups = await listGroups()
            .catch(() => groups);

        setGroups(refreshedGroups);
    }

    function handleAdd(event: SyntheticEvent<HTMLFormElement>): void {
        event.preventDefault();
        setIsWorking(true);
        setProblem(undefined);

        addWithInvite()
            .catch((error: unknown) => {
                const errorText = getErrorText(error, 'Could not add person.');

                setProblem(errorText);
            })
            .finally(() => {
                setIsWorking(false);
            });
    }

    const isNewGroupMissing = invite.group === NEW_GROUP && invite.newGroupName.length === 0;

    function handlePersonState(person: Person): void {
        setIsWorking(true);
        setProblem(undefined);

        const changeState = person.state === 'active' ? deactivatePerson(person.name) : reactivatePerson(person.name);

        changeState
            .then((updatedPerson) => {
                setPeople((currentPeople) => {
                    const peopleWithUpdate = replacePerson(currentPeople, updatedPerson);

                    return peopleWithUpdate;
                });
            })
            .catch((error: unknown) => {
                const errorText = getErrorText(error, `Could not update ${person.name}.`);

                setProblem(errorText);
            })
            .finally(() => {
                setIsWorking(false);
            });
    }

    function handleResetPassword(person: Person): void {
        setIsWorking(true);
        setProblem(undefined);

        resetPersonPassword(person.name)
            .then((result) => {
                setCredential({ address: person.address, password: result.password });
            })
            .catch((error: unknown) => {
                const errorText = getErrorText(error, `Could not reset the password for ${person.name}.`);

                setProblem(errorText);
            })
            .finally(() => {
                setIsWorking(false);
            });
    }

    function handleDelete(person: Person): void {
        setIsWorking(true);
        setProblem(undefined);

        deletePerson(person.name)
            .then(() => {
                setPeople((currentPeople) => {
                    const remainingPeople = currentPeople.filter(currentPerson => currentPerson.name !== person.name);

                    return remainingPeople;
                });
                setDeleteName(undefined);
                setDeleteConfirmation('');
            })
            .catch((error: unknown) => {
                const errorText = getErrorText(error, `Could not delete ${person.name}.`);

                setProblem(errorText);
            })
            .finally(() => {
                setIsWorking(false);
            });
    }

    async function copyValue(value: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(value);
            setCopyProblem(undefined);
        } catch {
            setCopyProblem('Could not copy to the clipboard.');
        }
    }

    return (
        <section className="people-panel" aria-labelledby="people-title">
            <PanelHeader
                className="people-panel-header settings-page-header"
                closeLabel="Close people panel"
                onClose={onClose}
                title="People"
                titleId="people-title"
                description="Manage access to this CloudBot server."
            />

            {problem === undefined ? null : <p className="people-problem" role="alert">{problem}</p>}

            {credential === undefined
                ? null
                : (
                        <section className="setup-card people-credential" aria-label="One time password">
                            <p>Save this now. It is not shown again.</p>
                            <div className="people-credential-row">
                                <div>
                                    <span className="people-field-label">Address</span>
                                    <code>{credential.address}</code>
                                </div>
                                <Button onClick={() => { void copyValue(credential.address); }}>Copy address</Button>
                            </div>
                            <div className="people-credential-row">
                                <div>
                                    <span className="people-field-label">Password</span>
                                    <code>{credential.password}</code>
                                </div>
                                <Button onClick={() => { void copyValue(credential.password); }}>Copy password</Button>
                            </div>
                            {copyProblem === undefined ? null : <p className="people-problem" role="alert">{copyProblem}</p>}
                            <div className="choice-buttons">
                                <Button
                                    onClick={() => {
                                        setCredential(undefined);
                                        setCopyProblem(undefined);
                                    }}
                                >
                                    I saved it
                                </Button>
                            </div>
                        </section>
                    )}

            <form className="setup-card people-add-form" onSubmit={handleAdd}>
                <h2>Add person</h2>
                <div className="setup-form">
                    <Field label="Name">
                        <input autoComplete="off" value={name} onChange={(event) => { setName(event.currentTarget.value); }} />
                    </Field>
                    <GroupInviteFields groups={groups} bots={bots} choice={invite} onChange={setInvite} />
                    <Button type="submit" disabled={isWorking || name.length === 0 || isNewGroupMissing}>Add person</Button>
                </div>
            </form>

            <div className="people-list" aria-live="polite">
                {isLoading ? <p>Loading people...</p> : null}
                {!isLoading && people.length === 0 ? <p>No people yet.</p> : null}
                {people.map((person) => {
                    const isOwner = person.role === 'owner';
                    const isConfirmingDelete = deleteName === person.name;
                    const canDelete = deleteConfirmation === person.name;
                    const lastSeenDate = person.lastSeenAt === null ? undefined : new Date(person.lastSeenAt);
                    const lastSeen = lastSeenDate === undefined
                        ? 'Never'
                        : lastSeenDate
                                .toLocaleString();

                    return (
                        <article className="setup-card people-person" key={person.name}>
                            <div className="people-person-heading">
                                <h2>{person.name}</h2>
                                <div className="people-chips">
                                    <span className={`people-chip state-${person.state}`}>{person.state === 'active' ? 'Active' : 'Inactive'}</span>
                                    <span className="people-chip">{INSTANCE_LABELS[person.instance]}</span>
                                </div>
                            </div>
                            <dl className="people-details">
                                <div>
                                    <dt>Address</dt>
                                    <dd>{person.address}</dd>
                                </div>
                                <div>
                                    <dt>Last seen</dt>
                                    <dd>{lastSeen}</dd>
                                </div>
                            </dl>
                            <div className="choice-buttons">
                                {isOwner
                                    ? null
                                    : (
                                            <Button disabled={isWorking} onClick={() => { handlePersonState(person); }}>
                                                {person.state === 'active' ? 'Deactivate' : 'Reactivate'}
                                            </Button>
                                        )}
                                <Button disabled={isWorking} onClick={() => { handleResetPassword(person); }}>Reset password</Button>
                                {isOwner
                                    ? null
                                    : (
                                            <Button
                                                disabled={isWorking}
                                                onClick={() => {
                                                    setDeleteName(isConfirmingDelete ? undefined : person.name);
                                                    setDeleteConfirmation('');
                                                    setProblem(undefined);
                                                }}
                                            >
                                                {isConfirmingDelete ? 'Cancel delete' : 'Delete'}
                                            </Button>
                                        )}
                            </div>
                            {isConfirmingDelete
                                ? (
                                        <div className="people-delete-confirmation">
                                            <Field label={`Type ${person.name} to confirm deletion`}>
                                                <input
                                                    autoComplete="off"
                                                    value={deleteConfirmation}
                                                    onChange={(event) => { setDeleteConfirmation(event.currentTarget.value); }}
                                                />
                                            </Field>
                                            <Button disabled={!canDelete || isWorking} onClick={() => { handleDelete(person); }}>Confirm delete</Button>
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

export { PeoplePanel };
export type { PeoplePanelProps };
