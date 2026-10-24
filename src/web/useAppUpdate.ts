import { useCallback, useEffect, useRef, useState } from 'react';

import { appBuildId, isNewAppBuild, parseAppBuild, reloadGuardDelay } from './appUpdate.ts';
import type { ReloadRecord } from './appUpdate.ts';

interface AppUpdateState {
    isUpdateReady: boolean;
    canApplyUpdate: boolean;
    applyUpdate: () => void;
    dismissUpdate: () => void;
}

interface EffectLifecycle {
    isActive: boolean;
}

interface ReloadStorageState {
    isAvailable: boolean;
    record: ReloadRecord | undefined;
}

const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const RELOAD_GUARD_STORAGE_KEY = 'cloudbot.update-reload';
const RELOAD_GUARD_PROBE_KEY = 'cloudbot.update-reload-probe';

function isEffectActive(lifecycle: EffectLifecycle): boolean {
    return lifecycle.isActive;
}

function readReloadRecord(): ReloadStorageState {
    try {
        const serializedRecord = window.sessionStorage.getItem(RELOAD_GUARD_STORAGE_KEY);

        if (serializedRecord === null) {
            return { isAvailable: true, record: undefined };
        }

        const record: unknown = JSON.parse(serializedRecord);

        if (typeof record !== 'object' || record === null) {
            return { isAvailable: false, record: undefined };
        }

        const fields = record as Record<string, unknown>;

        if (typeof fields.buildId !== 'string' || typeof fields.reloadedAt !== 'number') {
            return { isAvailable: false, record: undefined };
        }

        return { isAvailable: true, record: { buildId: fields.buildId, reloadedAt: fields.reloadedAt } };
    } catch {
        // Without a readable guard, reloading could repeat forever.
        return { isAvailable: false, record: undefined };
    }
}

function writeReloadRecord(buildId: string, reloadedAt: number): boolean {
    try {
        const serializedRecord = JSON.stringify({ buildId, reloadedAt });

        window.sessionStorage.setItem(RELOAD_GUARD_STORAGE_KEY, serializedRecord);

        return true;
    } catch {
        // Without a persisted guard, reloading could repeat forever.
        return false;
    }
}

function canUseReloadStorage(): boolean {
    try {
        const previousProbe = window.sessionStorage.getItem(RELOAD_GUARD_PROBE_KEY);

        window.sessionStorage.setItem(RELOAD_GUARD_PROBE_KEY, 'ready');
        const storedProbe = window.sessionStorage.getItem(RELOAD_GUARD_PROBE_KEY);

        if (previousProbe === null) {
            window.sessionStorage.removeItem(RELOAD_GUARD_PROBE_KEY);
        } else {
            window.sessionStorage.setItem(RELOAD_GUARD_PROBE_KEY, previousProbe);
        }

        return storedProbe === 'ready';
    } catch {
        // The Update button stays disabled when the reload guard cannot be saved.
        return false;
    }
}

function reloadCurrentPage(): void {
    window.location.reload();
}

function useAppUpdate(isBusy: boolean, reloadPage: () => void = reloadCurrentPage): AppUpdateState {
    const [isUpdateReady, setIsUpdateReady] = useState(false);
    const [canApplyUpdate, setCanApplyUpdate] = useState(true);
    const isBusyRef = useRef(isBusy);
    const pendingBuildIdRef = useRef<string | undefined>(undefined);
    const dismissedBuildIdRef = useRef<string | undefined>(undefined);
    const attemptReloadRef = useRef<(buildId: string) => void>(() => undefined);
    const retryTimerRef = useRef<number | undefined>(undefined);

    useEffect(() => {
        const currentBuild = parseAppBuild(document, document.baseURI);

        if (currentBuild === undefined) {
            return undefined;
        }

        const lifecycle = { isActive: true };
        let isChecking = false;
        let interval: number | undefined;

        const clearRetryTimer = (): void => {
            if (retryTimerRef.current !== undefined) {
                window.clearTimeout(retryTimerRef.current);
                retryTimerRef.current = undefined;
            }
        };

        const showUpdateReady = (targetBuildId: string, canApply = canUseReloadStorage()): void => {
            if (dismissedBuildIdRef.current !== targetBuildId) {
                setCanApplyUpdate(canApply);
                setIsUpdateReady(true);
            }
        };

        const attemptReload = (targetBuildId: string): void => {
            const storageState = readReloadRecord();

            if (!storageState.isAvailable) {
                showUpdateReady(targetBuildId, false);

                return;
            }

            const now = Date.now();
            const delay = reloadGuardDelay(storageState.record, targetBuildId, now);

            if (delay > 0) {
                showUpdateReady(targetBuildId);

                clearRetryTimer();
                retryTimerRef.current = window.setTimeout(() => {
                    retryTimerRef.current = undefined;

                    if (lifecycle.isActive && !isBusyRef.current && pendingBuildIdRef.current === targetBuildId) {
                        attemptReloadRef.current(targetBuildId);
                    }
                }, delay);

                return;
            }

            clearRetryTimer();
            const reloadedAt = Date.now();
            const isReloadRecordSaved = writeReloadRecord(targetBuildId, reloadedAt);

            if (!isReloadRecordSaved) {
                showUpdateReady(targetBuildId, false);

                return;
            }

            setCanApplyUpdate(true);
            setIsUpdateReady(false);
            reloadPage();
        };

        attemptReloadRef.current = attemptReload;

        const checkForUpdate = async (): Promise<void> => {
            if (!lifecycle.isActive || isChecking) {
                return;
            }

            isChecking = true;

            try {
                const response = await fetch('/', { cache: 'no-store', credentials: 'same-origin' });

                if (!response.ok) {
                    return;
                }

                const html = await response.text();
                const parser = new DOMParser();
                const freshDocument = parser.parseFromString(html, 'text/html');
                const freshBuild = parseAppBuild(freshDocument, document.baseURI);

                if (!isEffectActive(lifecycle) || freshBuild === undefined) {
                    return;
                }

                if (!isNewAppBuild(currentBuild, freshBuild)) {
                    pendingBuildIdRef.current = undefined;
                    dismissedBuildIdRef.current = undefined;
                    clearRetryTimer();
                    setCanApplyUpdate(true);
                    setIsUpdateReady(false);

                    return;
                }

                const targetBuildId = appBuildId(freshBuild);

                pendingBuildIdRef.current = targetBuildId;

                if (isBusyRef.current) {
                    showUpdateReady(targetBuildId);

                    return;
                }

                attemptReload(targetBuildId);
            } catch {
                // Offline and transient fetch failures leave the current app usable.
            } finally {
                isChecking = false;
            }
        };

        const clearIntervalIfRunning = (): void => {
            if (interval !== undefined) {
                window.clearInterval(interval);
                interval = undefined;
            }
        };

        const startIntervalIfVisible = (): void => {
            clearIntervalIfRunning();

            if (document.visibilityState === 'visible') {
                interval = window.setInterval(() => {
                    void checkForUpdate();
                }, UPDATE_CHECK_INTERVAL_MS);
            }
        };

        const handleVisibilityChange = (): void => {
            if (document.visibilityState === 'visible') {
                void checkForUpdate();
                startIntervalIfVisible();

                return;
            }

            clearIntervalIfRunning();
        };

        const handleOnline = (): void => {
            void checkForUpdate();
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('online', handleOnline);

        if (document.visibilityState === 'visible') {
            void checkForUpdate();
            startIntervalIfVisible();
        }

        return () => {
            lifecycle.isActive = false;
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('online', handleOnline);
            clearIntervalIfRunning();
            clearRetryTimer();

            if (attemptReloadRef.current === attemptReload) {
                attemptReloadRef.current = () => undefined;
            }
        };
    }, [reloadPage]);

    useEffect(() => {
        isBusyRef.current = isBusy;
        const pendingBuildId = pendingBuildIdRef.current;

        if (isBusy || pendingBuildId === undefined) {
            return;
        }

        attemptReloadRef.current(pendingBuildId);
    }, [isBusy]);

    const applyUpdate = useCallback((): void => {
        const pendingBuildId = pendingBuildIdRef.current;

        if (canApplyUpdate && pendingBuildId !== undefined) {
            attemptReloadRef.current(pendingBuildId);
        }
    }, [canApplyUpdate]);

    const dismissUpdate = useCallback((): void => {
        dismissedBuildIdRef.current = pendingBuildIdRef.current;
        setIsUpdateReady(false);
    }, []);

    return { isUpdateReady, canApplyUpdate, applyUpdate, dismissUpdate };
}

export { useAppUpdate };
export type { AppUpdateState };
