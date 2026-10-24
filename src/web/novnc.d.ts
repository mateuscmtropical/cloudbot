// noVNC ships no types. Only the parts DesktopPanel uses are declared.
declare module '@novnc/novnc' {
    interface RfbEvents {
        connect: Event;
        disconnect: CustomEvent<{ clean: boolean }>;
    }

    export default class RFB {
        public constructor(target: HTMLElement, urlOrChannel: string);
        public viewOnly: boolean;
        public scaleViewport: boolean;
        public resizeSession: boolean;
        public addEventListener<K extends keyof RfbEvents>(type: K, listener: (event: RfbEvents[K]) => void): void;
        public disconnect(): void;
        public sendKey(keysym: number, code: string | null, down?: boolean): void;
    }
}
