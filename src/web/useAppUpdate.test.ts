// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RELOAD_GUARD_MS } from './appUpdate.ts';
import { useAppUpdate } from './useAppUpdate.ts';

const CURRENT_SCRIPT = '/assets/main-abc12345.js';
const CURRENT_STYLE = '/assets/main-def67890.css';
const NEXT_SCRIPT = '/assets/main-bcd23456.js';
const NEXT_STYLE = '/assets/main-efg78901.css';
const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;

let visibilityState = 'visible';

interface HappyDomTestWindow extends Window {
    happyDOM: {
        settings: {
            disableCSSFileLoading: boolean;
            disableJavaScriptFileLoading: boolean;
            handleDisabledFileLoadingAsSuccess: boolean;
        };
    };
}

function htmlForBuild(script: string, stylesheet: string): string {
    return '<!doctype html><html><head><script type="module" src="' + script + '"></script><link rel="stylesheet" href="' + stylesheet + '"></head></html>';
}

function createResponse(html: string): Response {
    return {
        ok: true,
        text: () => Promise.resolve(html),
    } as Response;
}

function mockFetchPage(html: string): ReturnType<typeof vi.fn> {
    const fetchPage = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

    fetchPage.mockResolvedValue(createResponse(html));

    vi.stubGlobal('fetch', fetchPage);

    return fetchPage;
}

function setVisibility(state: string): void {
    visibilityState = state;
}

async function flushChecks(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    });
}

describe('useAppUpdate', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        const happyDomWindow = window as unknown as HappyDomTestWindow;

        happyDomWindow.happyDOM.settings.disableCSSFileLoading = true;
        happyDomWindow.happyDOM.settings.disableJavaScriptFileLoading = true;
        happyDomWindow.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;
        visibilityState = 'visible';
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => visibilityState,
        });
        document.head.innerHTML = htmlForBuild(CURRENT_SCRIPT, CURRENT_STYLE);
        window.sessionStorage.clear();
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        window.sessionStorage.clear();
        const happyDomWindow = window as unknown as HappyDomTestWindow;

        happyDomWindow.happyDOM.settings.disableCSSFileLoading = false;
        happyDomWindow.happyDOM.settings.disableJavaScriptFileLoading = false;
        happyDomWindow.happyDOM.settings.handleDisabledFileLoadingAsSuccess = false;
    });

    it('reloads as soon as an idle app finds a different build', async () => {
        const fetchPage = mockFetchPage(htmlForBuild(NEXT_SCRIPT, NEXT_STYLE));
        const reloadPage = vi.fn();

        renderHook(() => useAppUpdate(false, reloadPage));
        await flushChecks();

        expect(fetchPage)
            .toHaveBeenCalledWith('/', { cache: 'no-store', credentials: 'same-origin' });
        expect(reloadPage)
            .toHaveBeenCalledTimes(1);
    });

    it('shows an update while busy and reloads when the app becomes idle', async () => {
        mockFetchPage(htmlForBuild(NEXT_SCRIPT, NEXT_STYLE));
        const reloadPage = vi.fn();
        const rendered = renderHook(({ isBusy }: { isBusy: boolean }) => useAppUpdate(isBusy, reloadPage), { initialProps: { isBusy: true } });

        await flushChecks();

        expect(rendered.result.current.isUpdateReady)
            .toBe(true);
        expect(reloadPage)
            .not.toHaveBeenCalled();

        act(() => {
            rendered.result.current.dismissUpdate();
        });
        expect(rendered.result.current.isUpdateReady)
            .toBe(false);

        act(() => {
            rendered.rerender({ isBusy: false });
        });

        expect(reloadPage)
            .toHaveBeenCalledTimes(1);
    });

    it('does not reload when the fresh page is missing or a request fails', async () => {
        const reloadPage = vi.fn();
        const fetchPage = mockFetchPage('<!doctype html><html><body>Sign in</body></html>');

        renderHook(() => useAppUpdate(false, reloadPage));
        await flushChecks();

        expect(reloadPage)
            .not.toHaveBeenCalled();

        fetchPage.mockRejectedValueOnce(new Error('offline'));
        act(() => {
            window.dispatchEvent(new Event('online'));
        });
        await flushChecks();

        expect(reloadPage)
            .not.toHaveBeenCalled();
    });

    it('checks on visibility and online changes and polls only while visible', async () => {
        const fetchPage = mockFetchPage(htmlForBuild(CURRENT_SCRIPT, CURRENT_STYLE));

        renderHook(() => useAppUpdate(false, vi.fn()));
        await flushChecks();
        expect(fetchPage)
            .toHaveBeenCalledTimes(1);

        await act(async () => {
            vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(fetchPage)
            .toHaveBeenCalledTimes(2);

        act(() => {
            setVisibility('hidden');
            document.dispatchEvent(new Event('visibilitychange'));
            vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
        });
        await flushChecks();
        expect(fetchPage)
            .toHaveBeenCalledTimes(2);

        act(() => {
            window.dispatchEvent(new Event('online'));
        });
        await flushChecks();
        expect(fetchPage)
            .toHaveBeenCalledTimes(3);

        act(() => {
            setVisibility('visible');
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await flushChecks();
        expect(fetchPage)
            .toHaveBeenCalledTimes(4);
    });

    it('does not reload into the same target build twice within one minute', async () => {
        const fetchPage = mockFetchPage(htmlForBuild(NEXT_SCRIPT, NEXT_STYLE));
        const firstReload = vi.fn();
        const firstHook = renderHook(() => useAppUpdate(true, firstReload));

        await flushChecks();
        act(() => {
            firstHook.result.current.applyUpdate();
        });
        expect(firstReload)
            .toHaveBeenCalledTimes(1);
        firstHook.unmount();

        const secondReload = vi.fn();

        renderHook(() => useAppUpdate(false, secondReload));
        await flushChecks();
        expect(secondReload)
            .not.toHaveBeenCalled();

        await act(async () => {
            vi.advanceTimersByTime(RELOAD_GUARD_MS - 1);
            await Promise.resolve();
        });
        expect(secondReload)
            .not.toHaveBeenCalled();

        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(secondReload)
            .toHaveBeenCalledTimes(1);
        expect(fetchPage)
            .toHaveBeenCalledTimes(2);
    });

    it('keeps an update ready but disables applying it when the reload guard cannot be saved', async () => {
        mockFetchPage(htmlForBuild(NEXT_SCRIPT, NEXT_STYLE));
        const reloadPage = vi.fn();
        const saveRecord = vi.spyOn(window.sessionStorage, 'setItem');

        saveRecord.mockImplementation(() => {
            throw new Error('storage blocked');
        });

        const rendered = renderHook(() => useAppUpdate(true, reloadPage));

        await flushChecks();

        expect(rendered.result.current.isUpdateReady)
            .toBe(true);
        expect(rendered.result.current.canApplyUpdate)
            .toBe(false);
        expect(reloadPage)
            .not.toHaveBeenCalled();
    });
});
