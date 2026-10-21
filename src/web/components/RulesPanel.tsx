import { useEffect, useId, useState } from 'react';
import type { ReactElement, SyntheticEvent } from 'react';

import type { BotRule } from '../../shared/chatTypes.ts';
import { RequestFailedError, addRule, listRules, removeRule } from '../apiClient.ts';

interface RulesPanelProps {
    botId: string;
    botName: string;
    onClose: () => void;
}

type LoadState = 'loading' | 'ready' | 'failed';

// Tool names are typed as a comma separated list, such as "Bash(rm:*), WebFetch".
function splitToolNames(toolText: string): string[] {
    return toolText.split(',')
        .map(toolName => toolName.trim())
        .filter(toolName => toolName !== '');
}

function describeFailure(error: unknown): string {
    if (error instanceof RequestFailedError && error.serverMessage !== undefined) {
        return error.serverMessage;
    }

    return 'The rules could not be saved. Try again.';
}

// The owner's rules for one bot. Only the owner sees this panel. The bot has no tool for rules.
function RulesPanel({ botId, botName, onClose }: RulesPanelProps): ReactElement {
    const [rules, setRules] = useState<BotRule[]>([]);
    const [loadState, setLoadState] = useState<LoadState>('loading');
    const [kind, setKind] = useState<BotRule['kind']>('block');
    const [text, setText] = useState('');
    const [toolText, setToolText] = useState('');
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [isSaving, setIsSaving] = useState(false);
    // Rules with a removal in progress, so a double click sends one request.
    const [removingIds, setRemovingIds] = useState<string[]>([]);
    // Bumped by the retry button to load the rules again.
    const [loadAttempt, setLoadAttempt] = useState(0);
    const textId = useId();
    const toolsId = useId();
    const kindId = useId();

    useEffect(() => {
        // The panel is mounted for one bot, so the first state is already loading.
        let isCurrent = true;

        listRules(botId)
            .then((loadedRules) => {
                if (isCurrent) {
                    setRules(loadedRules);
                    setLoadState('ready');
                }
            })
            .catch(() => {
                if (isCurrent) {
                    setLoadState('failed');
                }
            });

        return () => {
            isCurrent = false;
        };
    }, [botId, loadAttempt]);

    function handleAdd(event: SyntheticEvent<HTMLFormElement>): void {
        event.preventDefault();

        if (text.trim() === '' || isSaving) {
            return;
        }

        const blockedTools = kind === 'block' ? splitToolNames(toolText) : [];

        setIsSaving(true);
        setProblem(undefined);
        addRule(botId, { kind, text, blockedTools })
            .then((addedRule) => {
                setRules(currentRules => [...currentRules, addedRule]);
                setText('');
                setToolText('');
            })
            .catch((error: unknown) => {
                const failureText = describeFailure(error);

                setProblem(failureText);
            })
            .finally(() => {
                setIsSaving(false);
            });
    }

    function handleRemove(ruleId: string): void {
        if (removingIds.includes(ruleId)) {
            return;
        }

        setProblem(undefined);
        setRemovingIds(currentIds => [...currentIds, ruleId]);
        removeRule(botId, ruleId)
            .then(() => {
                setRules(currentRules => currentRules.filter(rule => rule.id !== ruleId));
            })
            .catch((error: unknown) => {
                const failureText = describeFailure(error);

                setProblem(failureText);
            })
            .finally(() => {
                setRemovingIds(currentIds => currentIds.filter(currentId => currentId !== ruleId));
            });
    }

    return (
        <div className="rules-panel" role="dialog" aria-label={`Rules for ${botName}`}>
            <div className="rules-header">
                <h2>{`Rules for ${botName}`}</h2>
                <button type="button" className="icon-button" aria-label="Close rules" onClick={onClose}>
                    &#10005;
                </button>
            </div>
            <p className="rules-help">
                The bot reads these rules before every task. A block rule can also name tools it cannot use, such as Bash(rm:*) or WebFetch.
            </p>
            {loadState === 'loading' ? <p>Loading...</p> : null}
            {loadState === 'failed'
                ? (
                        <p className="rules-problem">
                            The rules could not be loaded.
                            {' '}
                            <button
                                type="button"
                                onClick={() => {
                                    setLoadState('loading');
                                    setLoadAttempt(attempt => attempt + 1);
                                }}
                            >
                                Try again
                            </button>
                        </p>
                    )
                : null}
            {loadState === 'ready' && rules.length === 0 ? <p>No rules yet.</p> : null}
            <ul className="rules-list">
                {rules.map(rule => (
                    <li key={rule.id} className={`rule-item is-${rule.kind}`}>
                        <span className="rule-kind">{rule.kind === 'allow' ? 'Allowed' : 'Not allowed'}</span>
                        <span className="rule-text">{rule.text}</span>
                        {rule.blockedTools.length === 0
                            ? null
                            : <span className="rule-tools">{`Blocked tools: ${rule.blockedTools.join(', ')}`}</span>}
                        <button
                            type="button"
                            disabled={removingIds.includes(rule.id)}
                            aria-label={`Remove rule: ${rule.text}`}
                            onClick={() => {
                                handleRemove(rule.id);
                            }}
                        >
                            Remove
                        </button>
                    </li>
                ))}
            </ul>
            {loadState !== 'ready'
                ? null
                : (
                        <form className="rules-form" onSubmit={handleAdd}>
                            <label htmlFor={kindId}>Kind</label>
                            <select
                                id={kindId}
                                value={kind}
                                onChange={(event) => {
                                    setKind(event.target.value === 'allow' ? 'allow' : 'block');
                                }}
                            >
                                <option value="block">Not allowed</option>
                                <option value="allow">Allowed</option>
                            </select>
                            <label htmlFor={textId}>Rule</label>
                            <input
                                id={textId}
                                value={text}
                                maxLength={300}
                                placeholder="Never buy anything without asking me."
                                onChange={(event) => {
                                    setText(event.target.value);
                                }}
                            />
                            {kind === 'block'
                                ? (
                                        <>
                                            <label htmlFor={toolsId}>Blocked tools (optional)</label>
                                            <input
                                                id={toolsId}
                                                value={toolText}
                                                placeholder="Bash(rm:*), WebFetch"
                                                onChange={(event) => {
                                                    setToolText(event.target.value);
                                                }}
                                            />
                                        </>
                                    )
                                : null}
                            <button type="submit" disabled={text.trim() === '' || isSaving}>
                                {isSaving ? 'Saving...' : 'Add rule'}
                            </button>
                        </form>
                    )}
            {problem === undefined ? null : <p className="rules-problem" role="alert">{problem}</p>}
        </div>
    );
}

export { RulesPanel, splitToolNames };
export type { RulesPanelProps };
