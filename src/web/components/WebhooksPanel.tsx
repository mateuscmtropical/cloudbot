import { useEffect, useState } from 'react';
import type { ReactElement, SyntheticEvent } from 'react';

import { ANY_PROVIDER, SIGNED_WEBHOOK_PROVIDERS, UNKNOWN_PROVIDER } from '../../shared/webhookTypes.ts';
import type { BotWebhook, CreatedBotWebhook, WebhookCall, WebhookRule } from '../../shared/webhookTypes.ts';
import { createWebhook, listWebhooks, removeWebhook, RequestFailedError, setWebhookRule, setWebhookSecret } from '../apiClient.ts';
import { Button } from './Button.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { Field } from './Field.tsx';
import { ListGroup } from './ListGroup.tsx';
import { ListRow } from './ListRow.tsx';
import { PanelHeader } from './PanelHeader.tsx';
import { WebhookUrlNotice } from './WebhookUrlNotice.tsx';

interface WebhooksPanelBot {
    id: string;
    name: string;
}

interface WebhooksPanelProps {
    bot: WebhooksPanelBot;
    onClose: () => void;
}

interface WebhookCardProps {
    botId: string;
    webhook: BotWebhook;
    onChanged: (webhook: BotWebhook) => void;
    onRemoved: (webhookId: string) => void;
}

const SHOWN_CALLS = 10;
const KNOWN_PROVIDERS = ['github', 'gitlab', 'bitbucket', 'stripe', 'shopify', 'slack', 'linear', 'sentry', 'twilio', 'discord', 'svix', 'meta'];

function errorText(error: unknown, fallback: string): string {
    return error instanceof RequestFailedError && error.serverMessage !== undefined ? error.serverMessage : fallback;
}

function providerLabel(provider: string): string {
    return provider === ANY_PROVIDER ? 'Any other caller' : provider;
}

function describeCall(call: WebhookCall): string {
    const time = new Date(call.time);
    const parts = [time.toLocaleString(), call.address, call.userAgent];
    const known = parts.filter(part => part !== undefined);

    return known.join(', ');
}

function callTitle(call: WebhookCall): string {
    return call.event === undefined ? call.provider : `${call.provider}: ${call.event}`;
}

// The providers already seen come first, because a rule is usually for one of them.
function providerChoices(webhook: BotWebhook): string[] {
    const seen = webhook.calls.map(call => call.provider);
    const named = seen.filter(provider => provider !== UNKNOWN_PROVIDER);

    return [...new Set([...named, ...KNOWN_PROVIDERS, ANY_PROVIDER])];
}

function WebhookCard({ botId, webhook, onChanged, onRemoved }: WebhookCardProps): ReactElement {
    const [provider, setProvider] = useState('');
    const [instruction, setInstruction] = useState('');
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [isBusy, setIsBusy] = useState(false);
    const [isDeleteOpen, setIsDeleteOpen] = useState(false);
    const [secretProvider, setSecretProvider] = useState(SIGNED_WEBHOOK_PROVIDERS[0] ?? '');
    const [secret, setSecret] = useState('');
    const listId = `webhook-providers-${webhook.id}`;
    const choices = providerChoices(webhook);
    const shownCalls = webhook.calls.slice(0, SHOWN_CALLS);

    function saveRule(ruleProvider: string, ruleInstruction: string, onSaved?: () => void): void {
        setIsBusy(true);
        setProblem(undefined);
        setWebhookRule(botId, webhook.id, ruleProvider, ruleInstruction)
            .then((saved) => {
                onChanged(saved);
                onSaved?.();
            })
            .catch((error: unknown) => {
                const text = errorText(error, 'Could not save the rule.');

                setProblem(text);
            })
            .finally(() => {
                setIsBusy(false);
            });
    }

    function handleAddRule(event: SyntheticEvent<HTMLFormElement>): void {
        event.preventDefault();

        const providerName = provider.trim()
            .toLowerCase();

        saveRule(providerName, instruction, () => {
            setProvider('');
            setInstruction('');
        });
    }

    function saveSecret(provider: string, value: string, onSaved?: () => void): void {
        setIsBusy(true);
        setProblem(undefined);
        setWebhookSecret(botId, webhook.id, provider, value)
            .then((saved) => {
                onChanged(saved);
                onSaved?.();
            })
            .catch((error: unknown) => {
                const text = errorText(error, 'Could not save the secret.');

                setProblem(text);
            })
            .finally(() => {
                setIsBusy(false);
            });
    }

    function handleAddSecret(event: SyntheticEvent<HTMLFormElement>): void {
        event.preventDefault();
        saveSecret(secretProvider, secret, () => {
            setSecret('');
        });
    }

    function signedRow(provider: string): ReactElement {
        return (
            <ListRow
                key={provider}
                title={provider}
                description="Calls that claim this provider need its signature."
                trailingControl={(
                    <Button
                        disabled={isBusy}
                        onClick={() => {
                            saveSecret(provider, '');
                        }}
                    >
                        Remove
                    </Button>
                )}
            />
        );
    }

    function confirmDelete(): void {
        setIsBusy(true);
        removeWebhook(botId, webhook.id)
            .then(() => {
                onRemoved(webhook.id);
            })
            .catch((error: unknown) => {
                const text = errorText(error, 'Could not delete the webhook.');

                setProblem(text);
                setIsDeleteOpen(false);
                setIsBusy(false);
            });
    }

    function ruleRow(rule: WebhookRule): ReactElement {
        return (
            <ListRow
                key={rule.provider}
                title={providerLabel(rule.provider)}
                description={rule.instruction}
                trailingControl={(
                    <Button
                        disabled={isBusy}
                        onClick={() => {
                            saveRule(rule.provider, '');
                        }}
                    >
                        Remove
                    </Button>
                )}
            />
        );
    }

    return (
        <div className="settings-section webhook-card">
            <ListGroup label={webhook.name} ariaLabel={`Rules of ${webhook.name}`}>
                {webhook.rules.map(ruleRow)}
                <form className="webhook-rule-form" aria-label={`Add a rule to ${webhook.name}`} onSubmit={handleAddRule}>
                    <Field label="Provider">
                        <input
                            type="text"
                            className="rename-input"
                            list={listId}
                            value={provider}
                            required
                            onChange={(event) => {
                                setProvider(event.target.value);
                            }}
                        />
                    </Field>
                    <datalist id={listId}>
                        {choices.map(choice => <option key={choice} value={choice} />)}
                    </datalist>
                    <Field label="What the bot should do">
                        <input
                            type="text"
                            className="rename-input"
                            value={instruction}
                            maxLength={500}
                            required
                            onChange={(event) => {
                                setInstruction(event.target.value);
                            }}
                        />
                    </Field>
                    <Button type="submit" disabled={isBusy}>Save rule</Button>
                </form>
            </ListGroup>
            <ListGroup label="Signatures" ariaLabel={`Signatures of ${webhook.name}`}>
                {webhook.signedProviders.map(signedRow)}
                <form className="webhook-rule-form" aria-label={`Add a signing secret to ${webhook.name}`} onSubmit={handleAddSecret}>
                    <Field label="Signed provider">
                        <select
                            className="rename-input"
                            value={secretProvider}
                            onChange={(event) => {
                                setSecretProvider(event.target.value);
                            }}
                        >
                            {SIGNED_WEBHOOK_PROVIDERS.map(choice => <option key={choice} value={choice}>{choice}</option>)}
                        </select>
                    </Field>
                    <Field label="Signing secret">
                        <input
                            type="password"
                            className="rename-input"
                            autoComplete="off"
                            value={secret}
                            maxLength={300}
                            required
                            onChange={(event) => {
                                setSecret(event.target.value);
                            }}
                        />
                    </Field>
                    <Button type="submit" disabled={isBusy}>Save secret</Button>
                </form>
            </ListGroup>
            {problem === undefined ? null : <p className="settings-error" role="alert">{problem}</p>}
            {shownCalls.length === 0
                ? <p className="settings-help-text">No calls yet.</p>
                : (
                        <ListGroup label="Last callers" ariaLabel={`Last callers of ${webhook.name}`}>
                            {shownCalls.map(call => <ListRow key={`${String(call.time)}-${call.provider}`} title={callTitle(call)} description={describeCall(call)} />)}
                        </ListGroup>
                    )}
            <Button
                disabled={isBusy}
                onClick={() => {
                    setIsDeleteOpen(true);
                }}
            >
                Delete webhook
            </Button>
            {isDeleteOpen
                ? (
                        <ConfirmDialog
                            title={`Delete ${webhook.name}?`}
                            message="Its URL stops working, and its rules and calls are removed."
                            isBusy={isBusy}
                            onConfirm={confirmDelete}
                            onCancel={() => {
                                setIsDeleteOpen(false);
                            }}
                        />
                    )
                : null}
        </div>
    );
}

// The owner's page for one bot's webhooks: make one, see who called, and say what to do for each provider.
function WebhooksPanel({ bot, onClose }: WebhooksPanelProps): ReactElement {
    const [webhooks, setWebhooks] = useState<BotWebhook[] | undefined>(undefined);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [name, setName] = useState('');
    const [isCreating, setIsCreating] = useState(false);
    const [created, setCreated] = useState<CreatedBotWebhook | undefined>(undefined);

    useEffect(() => {
        let isCurrent = true;

        listWebhooks(bot.id)
            .then((listed) => {
                if (isCurrent) {
                    setWebhooks(listed);
                }
            })
            .catch((error: unknown) => {
                if (isCurrent) {
                    const text = errorText(error, 'Could not load the webhooks.');

                    setProblem(text);
                }
            });

        return () => {
            isCurrent = false;
        };
    }, [bot.id]);

    function handleCreate(event: SyntheticEvent<HTMLFormElement>): void {
        event.preventDefault();
        setIsCreating(true);
        setProblem(undefined);
        createWebhook(bot.id, name)
            .then((made) => {
                setCreated(made);
                setName('');
                setWebhooks(current => [...(current ?? []), made]);
            })
            .catch((error: unknown) => {
                const text = errorText(error, 'Could not make the webhook.');

                setProblem(text);
            })
            .finally(() => {
                setIsCreating(false);
            });
    }

    return (
        <section className="people-panel" aria-labelledby="webhooks-title">
            <PanelHeader
                className="people-panel-header settings-page-header"
                closeLabel="Back to profile"
                onClose={onClose}
                title="Webhooks"
                titleId="webhooks-title"
                description={`Outside services can call ${bot.name} at a webhook URL. A call starts a turn, and its text counts as data from outside.`}
            />

            <div className="account-panel-content">
                <form className="webhook-rule-form" aria-label="Make a webhook" onSubmit={handleCreate}>
                    <Field label="New webhook name">
                        <input
                            type="text"
                            className="rename-input"
                            value={name}
                            maxLength={60}
                            required
                            onChange={(event) => {
                                setName(event.target.value);
                            }}
                        />
                    </Field>
                    <Button type="submit" tone="selected" disabled={isCreating}>Make webhook</Button>
                </form>
                {created === undefined
                    ? null
                    : (
                            <WebhookUrlNotice
                                name={created.name}
                                url={created.url}
                                onHide={() => {
                                    setCreated(undefined);
                                }}
                            />
                        )}
                {problem === undefined ? null : <p className="settings-error" role="alert">{problem}</p>}
                {webhooks === undefined && problem === undefined ? <p className="panel-loading" role="status">Loading...</p> : null}
                {webhooks?.length === 0 ? <p className="settings-help-text">No webhooks yet.</p> : null}
                {webhooks?.map(webhook => (
                    <WebhookCard
                        key={webhook.id}
                        botId={bot.id}
                        webhook={webhook}
                        onChanged={(saved) => {
                            setWebhooks(current => current?.map(known => known.id === saved.id ? saved : known));
                        }}
                        onRemoved={(webhookId) => {
                            setWebhooks(current => current?.filter(known => known.id !== webhookId));
                        }}
                    />
                ))}
            </div>
        </section>
    );
}

export { WebhooksPanel };
export type { WebhooksPanelProps };
