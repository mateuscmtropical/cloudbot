import type { Socket } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_DESKTOP_SIZE } from '../../shared/desktopSize.ts';
import { buildSetDesktopSizeMessage } from './RfbInputFilter.ts';
import { DesktopResizeCoordinator } from './DesktopResizeCoordinator.ts';

interface FakeSocket {
    destroyed: boolean;
    writableEnded: boolean;
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
}

function makeSocket(): FakeSocket {
    return {
        destroyed: false,
        writableEnded: false,
        write: vi.fn(() => true),
        end: vi.fn(),
    };
}

function asSocket(socket: FakeSocket): Socket {
    return socket as unknown as Socket;
}

describe('DesktopResizeCoordinator', () => {
    it('leaves the newest desktop size in place when an older panel closes', () => {
        const coordinator = new DesktopResizeCoordinator();
        const firstOwner = {};
        const secondOwner = {};
        const firstSocket = makeSocket();
        const secondSocket = makeSocket();

        coordinator.request(firstOwner, asSocket(firstSocket), { width: 500, height: 756 });
        coordinator.request(secondOwner, asSocket(secondSocket), { width: 720, height: 1280 });

        expect(coordinator.release(firstOwner, asSocket(firstSocket)))
            .toBe(false);
        expect(firstSocket.write)
            .not.toHaveBeenCalled();
        expect(secondSocket.write)
            .not.toHaveBeenCalled();
        expect(firstSocket.end)
            .not.toHaveBeenCalled();
    });

    it('reapplies the latest surviving panel size when the newest panel closes', () => {
        const coordinator = new DesktopResizeCoordinator();
        const firstOwner = {};
        const secondOwner = {};
        const firstSocket = makeSocket();
        const secondSocket = makeSocket();

        coordinator.request(firstOwner, asSocket(firstSocket), { width: 500, height: 756 });
        coordinator.request(secondOwner, asSocket(secondSocket), { width: 720, height: 1280 });

        expect(coordinator.release(secondOwner, asSocket(secondSocket)))
            .toBe(false);
        expect(firstSocket.write)
            .toHaveBeenCalledWith(buildSetDesktopSizeMessage({ width: 500, height: 756 }));
        expect(secondSocket.end)
            .not.toHaveBeenCalled();
    });

    it('restores the default size when the last resized panel closes', () => {
        const coordinator = new DesktopResizeCoordinator();
        const owner = {};
        const socket = makeSocket();

        coordinator.request(owner, asSocket(socket), { width: 500, height: 756 });

        expect(coordinator.release(owner, asSocket(socket)))
            .toBe(true);
        expect(socket.end)
            .toHaveBeenCalledWith(buildSetDesktopSizeMessage(DEFAULT_DESKTOP_SIZE));
    });

    it('restores once when the screen changes hands', () => {
        const coordinator = new DesktopResizeCoordinator();
        const owner = {};
        const socket = makeSocket();

        coordinator.request(owner, asSocket(socket), { width: 500, height: 756 });
        coordinator.restoreAll(asSocket(socket));
        coordinator.restoreAll(asSocket(socket));

        expect(socket.write)
            .toHaveBeenCalledTimes(1);
        expect(socket.write)
            .toHaveBeenCalledWith(buildSetDesktopSizeMessage(DEFAULT_DESKTOP_SIZE));
    });

    it('tells when a phone starts and stops holding the screen', () => {
        const changes: boolean[] = [];
        const coordinator = new DesktopResizeCoordinator((isPhoneHolding) => {
            changes.push(isPhoneHolding);
        });
        const firstOwner = {};
        const secondOwner = {};
        const socket = makeSocket();

        coordinator.request(firstOwner, asSocket(socket), { width: 500, height: 756 });
        coordinator.request(secondOwner, asSocket(socket), { width: 500, height: 756 });
        coordinator.release(firstOwner, asSocket(socket));
        coordinator.restoreAll(asSocket(socket));

        expect(changes)
            .toEqual([true, true, true, false]);
    });
});
