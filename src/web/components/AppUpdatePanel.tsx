import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { AppUpdateStatus } from '../../shared/peopleTypes.ts';
import { RequestFailedError } from '../apiClient.ts';
import { getAppUpdate, startAppUpdate } from '../peopleClient.ts';
import { Button } from './Button.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { ListGroup } from './ListGroup.tsx';
import { ListRow } from './ListRow.tsx';
import { PanelHeader } from './PanelHeader.tsx';

interface AppUpdatePanelProps {
    onClose: () => void;
    // How long to wait between looks while an update runs. Tests shorten it.
    pollMs?: number;
}

const DEFAULT_POLL_MS = 5000;
const SHORT_COMMIT_LENGTH = 7;
const STATE_TEXTS: Record<AppUpdateStatus['state'], string> = {
    idle: '',
    running: 'Updating. CloudBot may stop answering for a few minutes, and this page keeps checking.',
    done: 'The last update finished.',
    failed: 'The last update failed, and CloudBot kept running the version it had. See it on the server with: sudo journalctl -u cloudbot-update',
    unavailable: 'This server cannot update from the web app. On a Linux server with systemd, run: sudo cloudbot install-update',
};

function shortCommit(commit: string | undefined): string {
    return (commit ?? '').slice(0, SHORT_COMMIT_LENGTH);
}

function AppUpdatePanel({ onClose, pollMs = DEFAULT_POLL_MS }: AppUpdatePanelProps): ReactElement {
    const [status, setStatus] = useState<AppUpdateStatus | undefined>(undefined);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const [isStarting, setIsStarting] = useState(false);
    const isRunning = status?.state === 'running';

    useEffect(() => {
        let isCurrent = true;

        getAppUpdate()
            .then((current) => {
                if (isCurrent) {
                    setStatus(current);
                }
            })
            .catch(() => {
                if (isCurrent) {
                    setProblem('Could not read the state of the update.');
                }
            });

        return () => {
            isCurrent = false;
        };
    }, []);

    // The hub and this instance restart during an update, so a failed look only means to look again.
    useEffect(() => {
        if (!isRunning) {
            return undefined;
        }

        let isCurrent = true;
        const timer = setInterval(() => {
            getAppUpdate()
                .then((current) => {
                    if (isCurrent) {
                        setStatus(current);
                    }
                })
                .catch(() => undefined);
        }, pollMs);

        return () => {
            isCurrent = false;
            clearInterval(timer);
        };
    }, [isRunning, pollMs]);

    function confirmStart(): void {
        setIsStarting(true);
        setProblem(undefined);
        startAppUpdate()
            .then((started) => {
                setStatus(started);
            })
            .catch((error: unknown) => {
                const text = error instanceof RequestFailedError && error.serverMessage !== undefined ? error.serverMessage : 'Could not start the update.';

                setProblem(text);
            })
            .finally(() => {
                setIsStarting(false);
                setIsConfirmOpen(false);
            });
    }

    const canUpdate = status !== undefined && status.state !== 'unavailable' && !isRunning;
    const hasNewVersion = status?.commit !== undefined && status.commit !== status.latest;
    const stateText = status === undefined ? '' : STATE_TEXTS[status.state];

    return (
        <section className="people-panel" aria-labelledby="app-update-title">
            <PanelHeader
                className="people-panel-header settings-page-header"
                closeLabel="Close update"
                onClose={onClose}
                title="Update CloudBot"
                titleId="app-update-title"
                description="Installs the newest version for everyone on this server."
            />

            <div className="account-panel-content">
                {status?.commit === undefined
                    ? null
                    : (
                            <ListGroup ariaLabel="Version">
                                <ListRow title="This server runs" value={shortCommit(status.commit)} />
                                <ListRow title="Newest version" value={shortCommit(status.latest)} description={hasNewVersion ? 'A new version is out.' : 'You are up to date.'} />
                            </ListGroup>
                        )}
                {stateText === '' ? null : <p className="settings-help-text" role="status">{stateText}</p>}
                {problem === undefined ? null : <p className="settings-error" role="alert">{problem}</p>}
                {canUpdate
                    ? (
                            <Button
                                onClick={() => {
                                    setIsConfirmOpen(true);
                                }}
                            >
                                Update now
                            </Button>
                        )
                    : null}
            </div>

            {isConfirmOpen
                ? (
                        <ConfirmDialog
                            title="Update CloudBot?"
                            message="Everyone's bots restart, and any turn that is running stops. Chats and files stay."
                            confirmLabel="Update"
                            isBusy={isStarting}
                            onConfirm={confirmStart}
                            onCancel={() => {
                                setIsConfirmOpen(false);
                            }}
                        />
                    )
                : null}
        </section>
    );
}

export { AppUpdatePanel };
export type { AppUpdatePanelProps };
