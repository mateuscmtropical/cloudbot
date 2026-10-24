import { useEffect, useState } from 'react';
import type { ReactElement, SyntheticEvent } from 'react';

import type { Person, PersonWithPassword } from '../../shared/peopleTypes.ts';
import { RequestFailedError } from '../apiClient.ts';
import { addPerson, deactivatePerson, deletePerson, listPeople, reactivatePerson, resetPersonPassword } from '../peopleClient.ts';
import { CloseIcon } from './icons.tsx';
import { RoundButton } from './RoundButton.tsx';

interface PeoplePanelProps {
    onClose: () => void;
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

function PeoplePanel({ onClose }: PeoplePanelProps): ReactElement {
    const [people, setPeople] = useState<Person[]>([]);
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

    function handleAdd(event: SyntheticEvent<HTMLFormElement>): void {
        event.preventDefault();
        setIsWorking(true);
        setProblem(undefined);

        addPerson(name)
            .then((createdPerson) => {
                setPeople((currentPeople) => {
                    const remainingPeople = currentPeople.filter(person => person.name !== createdPerson.person.name);

                    return [createdPerson.person, ...remainingPeople];
                });
                const oneTimeCredential = toCredential(createdPerson);

                setCredential(oneTimeCredential);
                setName('');
            })
            .catch((error: unknown) => {
                const errorText = getErrorText(error, 'Could not add person.');

                setProblem(errorText);
            })
            .finally(() => {
                setIsWorking(false);
            });
    }

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
            <header className="people-panel-header settings-page-header">
                <RoundButton label="Close people panel" onClick={onClose}><CloseIcon /></RoundButton>
                <div className="settings-page-title">
                    <h1 id="people-title">People</h1>
                    <p>Manage access to this CloudBot server.</p>
                </div>
            </header>

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
                                <button type="button" className="choice-button" onClick={() => { void copyValue(credential.address); }}>Copy address</button>
                            </div>
                            <div className="people-credential-row">
                                <div>
                                    <span className="people-field-label">Password</span>
                                    <code>{credential.password}</code>
                                </div>
                                <button type="button" className="choice-button" onClick={() => { void copyValue(credential.password); }}>Copy password</button>
                            </div>
                            {copyProblem === undefined ? null : <p className="people-problem" role="alert">{copyProblem}</p>}
                            <div className="choice-buttons">
                                <button
                                    type="button"
                                    className="choice-button"
                                    onClick={() => {
                                        setCredential(undefined);
                                        setCopyProblem(undefined);
                                    }}
                                >
                                    I saved it
                                </button>
                            </div>
                        </section>
                    )}

            <form className="setup-card people-add-form" onSubmit={handleAdd}>
                <h2>Add person</h2>
                <label htmlFor="people-name">Name</label>
                <div className="setup-form">
                    <input id="people-name" autoComplete="off" value={name} onChange={(event) => { setName(event.currentTarget.value); }} />
                    <button type="submit" disabled={isWorking || name.length === 0}>Add person</button>
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
                                            <button type="button" className="choice-button" disabled={isWorking} onClick={() => { handlePersonState(person); }}>
                                                {person.state === 'active' ? 'Deactivate' : 'Reactivate'}
                                            </button>
                                        )}
                                <button type="button" className="choice-button" disabled={isWorking} onClick={() => { handleResetPassword(person); }}>Reset password</button>
                                {isOwner
                                    ? null
                                    : (
                                            <button
                                                type="button"
                                                className="choice-button"
                                                disabled={isWorking}
                                                onClick={() => {
                                                    setDeleteName(isConfirmingDelete ? undefined : person.name);
                                                    setDeleteConfirmation('');
                                                    setProblem(undefined);
                                                }}
                                            >
                                                {isConfirmingDelete ? 'Cancel delete' : 'Delete'}
                                            </button>
                                        )}
                            </div>
                            {isConfirmingDelete
                                ? (
                                        <div className="people-delete-confirmation">
                                            <label htmlFor={`confirm-delete-${person.name}`}>
                                                Type
                                                {' '}
                                                {person.name}
                                                {' '}
                                                to confirm deletion
                                            </label>
                                            <input
                                                id={`confirm-delete-${person.name}`}
                                                autoComplete="off"
                                                value={deleteConfirmation}
                                                onChange={(event) => { setDeleteConfirmation(event.currentTarget.value); }}
                                            />
                                            <button type="button" className="choice-button" disabled={!canDelete || isWorking} onClick={() => { handleDelete(person); }}>Confirm delete</button>
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
