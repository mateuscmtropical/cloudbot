import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { ActionLogRecord } from '../../shared/actionLogTypes.ts';
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
const DECISION_LABELS: Record<NonNullable<ActionLogRecord['decision']>, string> = {
    allowed: 'Allowed',
    refused: 'Refused by the review',
    owner_denied: 'Refused by you',
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
        return DECISION_LABELS[entry.decision];
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

    return `${outcome}${duration}. ${botName}, ${timeText}`;
}

// What the bots did, newest first. The server deletes entries after 30 days.
function ActionLogPanel({ bots, onClose }: ActionLogPanelProps): ReactElement {
    const [entries, setEntries] = useState<ActionLogRecord[] | undefined>(undefined);
    const [hasFailed, setHasFailed] = useState(false);
    const [botFilter, setBotFilter] = useState(ALL_BOTS);

    useEffect(() => {
        let isCurrent = true;

        const chosenBot = botFilter === ALL_BOTS ? undefined : botFilter;

        listActionLog(chosenBot)
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
    }, [botFilter]);

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
                description="What your bots did, without what they read or wrote. Entries are deleted after 30 days."
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
