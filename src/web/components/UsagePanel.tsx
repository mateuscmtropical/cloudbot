import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { InstanceUsage, ServerUsage } from '../../shared/usageTypes.ts';
import { getOwnUsage, getServerUsage } from '../peopleClient.ts';
import { ListGroup } from './ListGroup.tsx';
import { ListRow } from './ListRow.tsx';
import { PanelHeader } from './PanelHeader.tsx';

interface UsagePanelProps {
    onClose: () => void;
    // The owner sees the machine and every instance. Everyone else sees their own instance.
    isOwner: boolean;
    // How long to wait between looks while the panel is open. Tests shorten it.
    pollMs?: number;
}

interface GaugeProps {
    label: string;
    text: string;
    value: number;
    max: number;
}

const DEFAULT_POLL_MS = 5000;
const BYTES_PER_UNIT = 1024;
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
const PERCENT_PER_CORE = 100;
const ROLE_LABELS: Record<InstanceUsage['role'], string> = { owner: 'Owner', member: 'Member', group: 'Shared group' };
const NOT_RUNNING_TEXTS: Record<InstanceUsage['instance'], string> = {
    running: 'No numbers yet.',
    starting: 'Starting.',
    stopped: 'Hibernated. It starts again when someone opens it.',
    missing: 'There is no container yet.',
};
const OWNER_NOTE = 'Machine numbers are read from inside the hub container. Memory, CPU count and load are the whole machine\'s. Disk is the disk that holds the hub and the Docker data. Instance numbers come from Docker. 100% of CPU is one core.';
const MEMBER_NOTE = 'These numbers are for your own CloudBot only. 100% of CPU is one core.';

function formatBytes(bytes: number): string {
    const power = Math.floor(Math.log(bytes) / Math.log(BYTES_PER_UNIT));
    const unitIndex = bytes < 1 ? 0 : Math.min(BYTE_UNITS.length - 1, power);
    const scaled = bytes / BYTES_PER_UNIT ** unitIndex;

    return `${scaled.toFixed(unitIndex === 0 || scaled >= 100 ? 0 : 1)} ${BYTE_UNITS[unitIndex] ?? 'B'}`;
}

// A native meter turns yellow and red by itself when the value nears the maximum.
function Gauge({ label, text, value, max }: GaugeProps): ReactElement {
    const safeMax = max > 0 ? max : 1;

    return (
        <span className="usage-gauge">
            <span>{`${label}: ${text}`}</span>
            <meter className="usage-meter" aria-label={label} min={0} max={safeMax} low={safeMax * 0.75} high={safeMax * 0.9} optimum={0} value={Math.min(value, safeMax)} />
        </span>
    );
}

function InstanceGauges({ usage }: { usage: InstanceUsage }): ReactElement {
    const { numbers } = usage;

    if (numbers === null) {
        return <span>{NOT_RUNNING_TEXTS[usage.instance]}</span>;
    }

    const cores = numbers.cpuLimitPercent / PERCENT_PER_CORE;
    const cpuPercent = Math.round(numbers.cpuPercent);

    return (
        <>
            <Gauge label="CPU" text={`${String(cpuPercent)}% of ${String(cores)} cores`} value={numbers.cpuPercent} max={numbers.cpuLimitPercent} />
            <Gauge label="Memory" text={`${formatBytes(numbers.memoryBytes)} of ${formatBytes(numbers.memoryLimitBytes)}`} value={numbers.memoryBytes} max={numbers.memoryLimitBytes} />
        </>
    );
}

function InstanceRow({ usage, title }: { usage: InstanceUsage; title: string }): ReactElement {
    return <ListRow title={title} value={ROLE_LABELS[usage.role]} description={<InstanceGauges usage={usage} />} />;
}

function MachineGroup({ server }: { server: ServerUsage }): ReactElement {
    const { host } = server;

    return (
        <ListGroup label="Machine">
            <ListRow
                title="CPU load"
                description={<Gauge label="Load" text={`${host.loadAverage.toFixed(2)} on ${String(host.cpuCount)} cores`} value={host.loadAverage} max={host.cpuCount} />}
            />
            <ListRow
                title="Memory"
                description={<Gauge label="Used" text={`${formatBytes(host.memoryUsedBytes)} of ${formatBytes(host.memoryTotalBytes)}`} value={host.memoryUsedBytes} max={host.memoryTotalBytes} />}
            />
            <ListRow
                title="Disk"
                description={<Gauge label="Used" text={`${formatBytes(host.diskUsedBytes)} of ${formatBytes(host.diskTotalBytes)}`} value={host.diskUsedBytes} max={host.diskTotalBytes} />}
            />
        </ListGroup>
    );
}

function UsagePanel({ onClose, isOwner, pollMs = DEFAULT_POLL_MS }: UsagePanelProps): ReactElement {
    const [own, setOwn] = useState<InstanceUsage | undefined>(undefined);
    const [server, setServer] = useState<ServerUsage | undefined>(undefined);
    const [problem, setProblem] = useState<string | undefined>(undefined);

    // The next look is planned when the last one ends, so slow answers never pile up.
    useEffect(() => {
        let isCurrent = true;
        let timer: ReturnType<typeof setTimeout> | undefined;

        function look(): void {
            const request = isOwner
                ? getServerUsage()
                        .then((usage) => {
                            if (isCurrent) {
                                setServer(usage);
                            }
                        })
                : getOwnUsage()
                        .then((usage) => {
                            if (isCurrent) {
                                setOwn(usage);
                            }
                        });

            request
                .then(() => {
                    if (isCurrent) {
                        setProblem(undefined);
                    }
                })
                .catch(() => {
                    if (isCurrent) {
                        setProblem('Could not read the usage. Trying again.');
                    }
                })
                .finally(() => {
                    if (isCurrent) {
                        timer = setTimeout(look, pollMs);
                    }
                });
        }

        look();

        return () => {
            isCurrent = false;
            clearTimeout(timer);
        };
    }, [isOwner, pollMs]);

    const hasData = isOwner ? server !== undefined : own !== undefined;

    return (
        <section className="people-panel" aria-labelledby="usage-title">
            <PanelHeader
                className="people-panel-header settings-page-header"
                closeLabel="Close resource usage"
                onClose={onClose}
                title="Resource usage"
                titleId="usage-title"
                description={isOwner ? 'The server and each instance on it.' : 'What your CloudBot uses on the server.'}
            />

            <div className="account-panel-content">
                {hasData ? null : <p className="settings-help-text" role="status">Loading...</p>}
                {server === undefined || !isOwner ? null : <MachineGroup server={server} />}
                {server === undefined || !isOwner
                    ? null
                    : (
                            <ListGroup label="People and groups">
                                {server.instances.map(usage => <InstanceRow key={usage.name} usage={usage} title={usage.name} />)}
                            </ListGroup>
                        )}
                {own === undefined || isOwner
                    ? null
                    : (
                            <ListGroup label="Your CloudBot">
                                <InstanceRow usage={own} title={own.name} />
                            </ListGroup>
                        )}
                {problem === undefined ? null : <p className="settings-error" role="alert">{problem}</p>}
                {hasData ? <p className="settings-help-text">{isOwner ? OWNER_NOTE : MEMBER_NOTE}</p> : null}
            </div>
        </section>
    );
}

export { UsagePanel };
export type { UsagePanelProps };
