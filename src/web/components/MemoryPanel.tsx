import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { BotMemory, BotSummary } from '../../shared/chatTypes.ts';
import { getBotMemory, RequestFailedError, saveBotMemory } from '../apiClient.ts';
import { memorySections, withoutMemoryLine } from '../memoryLines.ts';
import type { MemoryLine } from '../memoryLines.ts';
import { Button } from './Button.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { Field } from './Field.tsx';
import { BackIcon, EditIcon, TrashIcon } from './icons.tsx';
import { ListGroup } from './ListGroup.tsx';
import { ListRow } from './ListRow.tsx';
import { RoundButton } from './RoundButton.tsx';

const LOAD_PROBLEM = 'The memory could not be loaded.';
const SAVE_PROBLEM = 'The memory could not be saved.';

interface MemoryPanelProps {
    bot: BotSummary;
    onClose: () => void;
}

// What a bot wrote in its memory file, line by line, for the owner to check, delete or rewrite.
function MemoryPanel({ bot, onClose }: MemoryPanelProps): ReactElement {
    const [memory, setMemory] = useState<BotMemory | undefined>(undefined);
    const [draft, setDraft] = useState<string | undefined>(undefined);
    const [lineToDelete, setLineToDelete] = useState<MemoryLine | undefined>(undefined);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [isSaving, setIsSaving] = useState(false);
    const sections = memory === undefined ? [] : memorySections(memory.text);

    useEffect(() => {
        let isCurrent = true;

        getBotMemory(bot.id)
            .then((loaded) => {
                if (isCurrent) {
                    setMemory(loaded);
                }
            })
            .catch(() => {
                if (isCurrent) {
                    setProblem(LOAD_PROBLEM);
                }
            });

        return () => {
            isCurrent = false;
        };
    }, [bot.id]);

    async function save(savedMemory: BotMemory, text: string): Promise<void> {
        setIsSaving(true);
        setProblem(undefined);

        try {
            await saveBotMemory(bot.id, text, savedMemory.text);
            setMemory({ text, isCut: false });
            setDraft(undefined);
            setLineToDelete(undefined);
        } catch (error: unknown) {
            const serverMessage = error instanceof RequestFailedError ? error.serverMessage : undefined;

            setProblem(serverMessage ?? SAVE_PROBLEM);

            // A refused save means the list on screen is old. A kept draft stays, so nothing the owner typed is lost.
            if (error instanceof RequestFailedError && error.status === 409) {
                setLineToDelete(undefined);

                const freshMemory = await getBotMemory(bot.id)
                    .catch(() => undefined);

                if (freshMemory !== undefined) {
                    setMemory(freshMemory);
                }
            }
        } finally {
            setIsSaving(false);
        }
    }

    function memoryContent(shownMemory: BotMemory): ReactElement {
        if (draft !== undefined) {
            return (
                <form
                    className="memory-edit-form"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save(shownMemory, draft);
                    }}
                >
                    <Field label="Memory">
                        <textarea
                            className="memory-edit-text"
                            value={draft}
                            rows={14}
                            autoFocus
                            readOnly={isSaving}
                            onChange={(event) => {
                                setDraft(event.target.value);
                            }}
                        />
                    </Field>
                    <div className="bot-edit-actions">
                        <Button
                            disabled={isSaving}
                            onClick={() => {
                                setDraft(undefined);
                                setProblem(undefined);
                            }}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" tone="selected" disabled={isSaving}>{isSaving ? 'Saving…' : 'Save'}</Button>
                    </div>
                </form>
            );
        }

        if (sections.length === 0) {
            return <p className="memory-empty">{`Nothing yet. What ${bot.name} learns about you shows up here.`}</p>;
        }

        return (
            <>
                {sections.map(section => (
                    <ListGroup key={section.lines[0]?.index} label={section.title} ariaLabel={section.title ?? 'Notes'}>
                        {section.lines.map(line => (
                            <ListRow
                                key={line.index}
                                title={line.text}
                                className="memory-line"
                                trailingControl={shownMemory.isCut
                                    ? undefined
                                    : (
                                            <RoundButton
                                                label={`Forget: ${line.text}`}
                                                onClick={() => {
                                                    setProblem(undefined);
                                                    setLineToDelete(line);
                                                }}
                                            >
                                                <TrashIcon />
                                            </RoundButton>
                                        )}
                            />
                        ))}
                    </ListGroup>
                ))}
            </>
        );
    }

    return (
        <section className="bot-profile-panel" aria-label={`${bot.name} memory`}>
            <header className="bot-profile-header">
                <RoundButton label="Back to profile" onClick={onClose}><BackIcon /></RoundButton>
                {memory === undefined || memory.isCut || draft !== undefined
                    ? null
                    : (
                            <RoundButton
                                label="Edit memory"
                                onClick={() => {
                                    setProblem(undefined);
                                    setDraft(memory.text);
                                }}
                            >
                                <EditIcon />
                            </RoundButton>
                        )}
            </header>
            <div className="bot-profile-content">
                <h1 className="memory-title">{`What ${bot.name} remembers`}</h1>
                {memory?.isCut === true ? <p className="memory-empty">This memory is larger than 64 KB, so only the start shows and it cannot be changed here.</p> : null}
                {problem === undefined || lineToDelete !== undefined ? null : <p className="bot-edit-problem" role="alert">{problem}</p>}
                {memory === undefined ? null : memoryContent(memory)}
            </div>
            {memory === undefined || lineToDelete === undefined
                ? null
                : (
                        <ConfirmDialog
                            title="Forget this?"
                            message={lineToDelete.text}
                            confirmLabel="Forget"
                            error={problem}
                            isBusy={isSaving}
                            onConfirm={() => {
                                const text = withoutMemoryLine(memory.text, lineToDelete.index);

                                void save(memory, text);
                            }}
                            onCancel={() => {
                                setLineToDelete(undefined);
                                setProblem(undefined);
                            }}
                        />
                    )}
        </section>
    );
}

export { MemoryPanel };
