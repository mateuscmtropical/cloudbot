import type { Socket } from 'node:net';

import { DEFAULT_DESKTOP_SIZE } from '../../shared/desktopSize.ts';
import type { DesktopSize } from '../../shared/desktopSize.ts';
import { buildSetDesktopSizeMessage } from './RfbInputFilter.ts';

const DEFAULT_DESKTOP_SIZE_MESSAGE = buildSetDesktopSizeMessage(DEFAULT_DESKTOP_SIZE);

interface ResizeRequest {
    owner: object;
    socket: Socket;
    size: DesktopSize;
}

type PhoneChange = (isPhoneHolding: boolean) => void;

function canWrite(socket: Socket): boolean {
    return !socket.destroyed && !socket.writableEnded;
}

// TigerVNC serves one shared display to every VNC connection. Keep the newest
// active owner's size in effect and restore the next one when a panel closes.
// Only a phone in portrait asks for a resize, so a held resize means a phone holds the screen.
class DesktopResizeCoordinator {
    private requests: ResizeRequest[] = [];
    private readonly onPhoneChange: PhoneChange | undefined;

    constructor(onPhoneChange?: PhoneChange) {
        this.onPhoneChange = onPhoneChange;
    }

    request(owner: object, socket: Socket, size: DesktopSize): void {
        this.requests = this.requests.filter(request => request.owner !== owner);
        this.requests.push({ owner, socket, size });
        this.onPhoneChange?.(true);
    }

    // Returns true when the closing socket ends with the default size queued.
    release(owner: object, closingSocket: Socket): boolean {
        const requestIndex = this.requests.findIndex(request => request.owner === owner);

        if (requestIndex < 0) {
            return false;
        }

        const wasLatest = requestIndex === this.requests.length - 1;

        this.requests.splice(requestIndex, 1);
        this.onPhoneChange?.(this.requests.length > 0);

        if (!wasLatest) {
            return false;
        }

        const latestRequest = this.requests.at(-1);

        if (latestRequest !== undefined) {
            const socket = canWrite(latestRequest.socket) ? latestRequest.socket : closingSocket;

            if (canWrite(socket)) {
                const message = buildSetDesktopSizeMessage(latestRequest.size);

                socket.write(message);
            }

            return false;
        }

        if (!canWrite(closingSocket)) {
            return false;
        }

        closingSocket.end(DEFAULT_DESKTOP_SIZE_MESSAGE);

        return true;
    }

    restoreAll(fallbackSocket: Socket): void {
        if (this.requests.length === 0) {
            return;
        }

        const latestRequest = this.requests.at(-1);
        const latestSocket = latestRequest?.socket;
        const socket = latestSocket !== undefined && canWrite(latestSocket) ? latestSocket : fallbackSocket;

        this.requests = [];
        this.onPhoneChange?.(false);

        if (canWrite(socket)) {
            socket.write(DEFAULT_DESKTOP_SIZE_MESSAGE);
        }
    }
}

export { DesktopResizeCoordinator };
