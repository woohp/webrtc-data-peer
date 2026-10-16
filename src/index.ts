const maximumTimerDelay = 2_147_483_647;

export interface WebrtcDataPeerOptions {
    initiator: boolean;
    channelLabel: string;
    channelOptions?: Omit<RTCDataChannelInit, "negotiated" | "id">;
    rtcConfig?: RTCConfiguration | undefined;
    iceGatheringTimeout?: number;
    fallbackMaxMessageSize?: number;
    maxBufferedAmount?: number;
    RTCPeerConnection?: typeof RTCPeerConnection;
    onOpen: (peer: WebrtcDataPeer) => void;
    onMessage: (peer: WebrtcDataPeer, data: ArrayBuffer) => void;
    onClose: (peer: WebrtcDataPeer) => void;
    onError: (peer: WebrtcDataPeer, error: unknown) => void;
}

export class WebrtcDataPeer {
    readonly pc: RTCPeerConnection;
    private readonly channelLabel: string;
    private readonly iceGatheringTimeout: number;
    private readonly fallbackMaxMessageSize: number;
    private readonly maxBufferedAmount: number;
    private readonly onOpen: WebrtcDataPeerOptions["onOpen"];
    private readonly onMessage: WebrtcDataPeerOptions["onMessage"];
    private readonly onClose: WebrtcDataPeerOptions["onClose"];
    private readonly onError: WebrtcDataPeerOptions["onError"];
    private _channel: RTCDataChannel | null = null;
    private _closed = false;
    private readonly destroyed: Promise<never>;
    private readonly rejectDestroyed: (error: Error) => void;

    constructor(opts: WebrtcDataPeerOptions) {
        let rejectDestroyed!: (error: Error) => void;
        this.destroyed = new Promise((_, reject) => (rejectDestroyed = reject));
        this.destroyed.catch(() => {});
        this.rejectDestroyed = rejectDestroyed;
        this.channelLabel = opts.channelLabel;
        this.iceGatheringTimeout = validateRange(
            "iceGatheringTimeout",
            opts.iceGatheringTimeout ?? 5000,
            maximumTimerDelay,
        );
        this.fallbackMaxMessageSize = validateRange(
            "fallbackMaxMessageSize",
            opts.fallbackMaxMessageSize ?? Number.POSITIVE_INFINITY,
            Number.POSITIVE_INFINITY,
        );
        this.maxBufferedAmount = validateRange(
            "maxBufferedAmount",
            opts.maxBufferedAmount ?? Number.POSITIVE_INFINITY,
            Number.POSITIVE_INFINITY,
        );
        this.onOpen = opts.onOpen;
        this.onMessage = opts.onMessage;
        this.onClose = opts.onClose;
        this.onError = opts.onError;
        const PeerConnection = opts.RTCPeerConnection ?? globalThis.RTCPeerConnection;
        if (!PeerConnection) throw new Error("RTCPeerConnection is not available");
        this.pc = new PeerConnection(opts.rtcConfig);
        this.pc.addEventListener("connectionstatechange", () => {
            if (this.pc.connectionState === "failed") this.destroy();
        });
        this.pc.addEventListener("datachannel", ({ channel }) => {
            if (this._closed) return channel.close();
            if (this._channel || channel.label !== this.channelLabel) {
                channel.close();
                this.reportError(
                    new Error(`Unexpected remote data channel ${JSON.stringify(channel.label)}`),
                );
            } else {
                this.attachChannel(channel);
            }
        });

        if (opts.initiator) {
            try {
                this.attachChannel(
                    this.pc.createDataChannel(this.channelLabel, {
                        ordered: true,
                        ...opts.channelOptions,
                        negotiated: false,
                    }),
                );
            } catch (error) {
                this._closed = true;
                this.pc.close();
                throw error;
            }
        }
    }

    get channel(): RTCDataChannel | null {
        return this._channel;
    }

    get closed(): boolean {
        return this._closed;
    }

    get connected(): boolean {
        return !this._closed && this._channel?.readyState === "open";
    }

    async createOffer(): Promise<RTCSessionDescriptionInit> {
        const offer = await this.step(() => this.pc.createOffer());
        await this.step(() => this.pc.setLocalDescription(offer));
        await this.step(() => this.waitForIceGatheringComplete());
        return this.localDescription();
    }

    async acceptOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
        await this.step(() => this.pc.setRemoteDescription(offer));
        const answer = await this.step(() => this.pc.createAnswer());
        await this.step(() => this.pc.setLocalDescription(answer));
        await this.step(() => this.waitForIceGatheringComplete());
        return this.localDescription();
    }

    async acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
        await this.step(() => this.pc.setRemoteDescription(answer));
        this.ensureOpen();
    }

    send(data: Uint8Array<ArrayBuffer>): boolean {
        const channel = this._channel;
        if (this._closed || channel?.readyState !== "open") return false;
        const negotiatedMax = this.pc.sctp?.maxMessageSize;
        const maxMessageSize =
            negotiatedMax === 0
                ? Number.POSITIVE_INFINITY
                : (negotiatedMax ?? this.fallbackMaxMessageSize);
        if (data.byteLength > maxMessageSize) {
            this.reportError(
                new Error(
                    `WebRTC message is ${data.byteLength} bytes, exceeding the ${maxMessageSize}-byte limit`,
                ),
            );
            return false;
        }
        if (channel.bufferedAmount + data.byteLength > this.maxBufferedAmount) {
            this.reportError(
                new Error(
                    `WebRTC buffered data would exceed the ${this.maxBufferedAmount}-byte limit`,
                ),
            );
            return false;
        }
        try {
            channel.send(data);
            return true;
        } catch (error) {
            this.reportError(error);
            return false;
        }
    }

    destroy(): void {
        if (this._closed) return;
        this._closed = true;
        this.rejectDestroyed(closedPeerError());
        this._channel?.close();
        this.pc.close();
        this.onClose(this);
    }

    private attachChannel(channel: RTCDataChannel): void {
        this._channel = channel;
        channel.binaryType = "arraybuffer";
        channel.addEventListener("open", () => {
            if (!this._closed) this.onOpen(this);
        });
        channel.addEventListener("message", (event) => {
            if (this._closed) return;
            if (event.data instanceof ArrayBuffer) {
                this.onMessage(this, event.data);
            } else {
                this.reportError(new Error("Expected an ArrayBuffer data channel message"));
            }
        });
        channel.addEventListener("close", () => this.destroy());
        channel.addEventListener("error", (event) => {
            if (!this._closed) this.reportError((event as RTCErrorEvent).error ?? event);
        });
    }

    // Native operations can stay pending after close, so each one races destruction.
    private step<T>(operation: () => Promise<T>): Promise<T> {
        this.ensureOpen();
        return Promise.race([this.destroyed, operation()]);
    }

    private waitForIceGatheringComplete(): Promise<void> {
        if (this.pc.iceGatheringState === "complete") return Promise.resolve();

        return new Promise((resolve) => {
            const done = (): void => {
                clearTimeout(timeout);
                this.pc.removeEventListener("icegatheringstatechange", onStateChange);
                resolve();
            };
            const onStateChange = (): void => {
                if (this.pc.iceGatheringState === "complete") done();
            };
            const timeout = setTimeout(done, this.iceGatheringTimeout);
            this.pc.addEventListener("icegatheringstatechange", onStateChange);
            this.destroyed.catch(done);
        });
    }

    private localDescription(): RTCSessionDescriptionInit {
        this.ensureOpen();
        const description = this.pc.localDescription;
        if (!description) throw new Error("Missing local RTC session description");
        return description.toJSON();
    }

    private reportError(error: unknown): void {
        try {
            this.onError(this, error);
        } catch {
            // Error callbacks are diagnostic and must not alter transport control flow.
        }
    }

    private ensureOpen(): void {
        if (this._closed) throw closedPeerError();
    }
}

const closedPeerError = (): Error => new Error("WebRTC data peer is closed");

const validateRange = (name: string, value: number, max: number): number => {
    if (!(value >= 0 && value <= max)) {
        throw new RangeError(`${name} must be between 0 and ${max}`);
    }
    return value;
};
