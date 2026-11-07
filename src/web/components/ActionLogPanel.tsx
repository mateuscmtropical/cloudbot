import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { ActionDecision, ActionLogRecord } from '../../shared/actionLogTypes.ts';
import { listActionLog } from '../apiClient.ts';
import { ListGroup } from './ListGroup.tsx';
import { ListRow } from './ListRow.tsx';
import { PanelHeader } from './PanelHeader.tsx';
import { Select } from './Select.tsx';

interface ActionLogBot {
    id: string;
    name: string;
}

interface ActionLogPanelProps {
    bots: ActionLogBot[];
    onClose: () => void;
}

const ALL_BOTS = '';
const OWN_TOOL_PREFIX = 'mcp__cloudbot__';
const ALL_DECISIONS = '';
const DECISION_LABELS: Record<ActionDecision, string> = {
    allowed: 'Allowed',
    owner_approved: 'Approved',
    owner_denied: 'Denied',
    blocked: 'Blocked',
    refused: 'Refused by the review',
    not_answered: 'Not answered',
    review_failed: 'The review failed',
};

// Own tools read as plain words. Any other tool keeps its name.
function describeTool(tool: string | undefined): string {
    if (tool === undefined) {
        return 'The turn failed';
    }

    if (!tool.startsWith(OWN_TOOL_PREFIX)) {
        return tool;
    }

    const ownName = tool.slice(OWN_TOOL_PREFIX.length);

    return ownName.replaceAll('_', ' ');
}

function describeOutcome(entry: ActionLogRecord): string {
    if (entry.decision !== undefined) {
        const by = entry.decidedBy === undefined ? '' : ` by ${entry.decidedBy}`;

        return `${DECISION_LABELS[entry.decision]}${by}`;
    }

    if (entry.event === 'turn_error') {
        return 'Error';
    }

    return entry.isError === true ? 'Finished with an error' : 'Finished';
}

function describeEntry(entry: ActionLogRecord, botName: string): string {
    const time = new Date(entry.at);
    const timeText = time.toLocaleString();
    const outcome = describeOutcome(entry);
    const duration = entry.durationMs === undefined ? '' : `, ${(entry.durationMs / 1000).toFixed(1)} s`;

    const note = entry.summary ?? entry.reason;
    const noteText = note === undefined ? '' : `. ${note}`;
    const channelText = entry.channelId === undefined ? '' : ', in a channel';

    return `${outcome}${duration}. ${botName}, ${timeText}${channelText}${noteText}`;
}

// What the bots did, newest first. The server deletes entries after 30 days.
function ActionLogPanel({ bots, onClose }: ActionLogPanelProps): ReactElement {
    const [entries, setEntries] = useState<ActionLogRecord[] | undefined>(undefined);
    const [hasFailed, setHasFailed] = useState(false);
    const [botFilter, setBotFilter] = useState(ALL_BOTS);
    const [decisionFilter, setDecisionFilter] = useState(ALL_DECISIONS);

    useEffect(() => {
        let isCurrent = true;

        const chosenBot = botFilter === ALL_BOTS ? undefined : botFilter;
        const chosenDecision = decisionFilter === ALL_DECISIONS ? undefined : decisionFilter;

        listActionLog(chosenBot, chosenDecision)
            .then((listed) => {
                if (isCurrent) {
                    setHasFailed(false);
                    setEntries(listed);
                }
            })
            .catch(() => {
                if (isCurrent) {
                    setHasFailed(true);
                }
            });

        return () => {
            isCurrent = false;
        };
    }, [botFilter, decisionFilter]);

    const decisionOptions = Object.entries(DECISION_LABELS)
        .map(([decision, label]) => <option key={decision} value={decision}>{label}</option>);
    const botPairs = bots.map((bot): [string, string] => [bot.id, bot.name]);
    const botNames = new Map(botPairs);
    const rows = (entries ?? []).map((entry, index) => {
        const botName = botNames.get(entry.botId) ?? 'A deleted bot';
        const title = describeTool(entry.tool);

        return <ListRow key={`${entry.at}-${String(index)}`} title={title} description={describeEntry(entry, botName)} />;
    });

    return (
        <section className="people-panel" aria-labelledby="action-log-title">
            <PanelHeader
                className="people-panel-header settings-page-header"
                closeLabel="Close action log"
                onClose={onClose}
                title="Action log"
                titleId="action-log-title"
                description="What your bots did and who allowed, denied or blocked it, without what they read or wrote. Entries are deleted after 30 days."
            />

            <div className="account-panel-content">
                <Select
                    label="Show the actions of"
                    value={botFilter}
                    onChange={(event) => {
                        setBotFilter(event.target.value);
                    }}
                >
                    <option value={ALL_BOTS}>All bots</option>
                    {bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
                </Select>
                <Select
                    label="Show the outcome"
                    value={decisionFilter}
                    onChange={(event) => {
                        setDecisionFilter(event.target.value);
                    }}
                >
                    <option value={ALL_DECISIONS}>All outcomes</option>
                    {decisionOptions}
                </Select>
                {hasFailed ? <p className="settings-error" role="alert">Could not load the action log.</p> : null}
                {entries === undefined && !hasFailed ? <p className="panel-loading" role="status">Loading...</p> : null}
                {entries?.length === 0 ? <p className="settings-help-text">No actions yet.</p> : null}
                {rows.length > 0 ? <ListGroup ariaLabel="Actions">{rows}</ListGroup> : null}
            </div>
        </section>
    );
}

export { ActionLogPanel };
export type { ActionLogPanelProps };
