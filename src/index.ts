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
    onDebug?: (event: Record<string, unknown>) => void;
}

export class WebrtcDataPeer {
    readonly pc: RTCPeerConnection;
    readonly initiator: boolean;
    readonly channelLabel: string;
    readonly iceGatheringTimeout: number;
    readonly fallbackMaxMessageSize: number;
    readonly maxBufferedAmount: number;
    readonly onOpen: WebrtcDataPeerOptions["onOpen"];
    readonly onMessage: WebrtcDataPeerOptions["onMessage"];
    readonly onClose: WebrtcDataPeerOptions["onClose"];
    readonly onError: WebrtcDataPeerOptions["onError"];
    readonly onDebug: NonNullable<WebrtcDataPeerOptions["onDebug"]>;
    private _channel: RTCDataChannel | null = null;
    private _closed = false;
    private readonly iceWaits = new Set<(error?: Error) => void>();

    constructor(opts: WebrtcDataPeerOptions) {
        this.initiator = opts.initiator;
        this.channelLabel = opts.channelLabel;
        this.iceGatheringTimeout = validateTimeout(
            "iceGatheringTimeout",
            opts.iceGatheringTimeout ?? 5000,
        );
        this.fallbackMaxMessageSize = validateLimit(
            "fallbackMaxMessageSize",
            opts.fallbackMaxMessageSize ?? Number.POSITIVE_INFINITY,
        );
        this.maxBufferedAmount = validateLimit(
            "maxBufferedAmount",
            opts.maxBufferedAmount ?? Number.POSITIVE_INFINITY,
        );
        validateChannelOptions(opts.channelOptions);
        this.onOpen = opts.onOpen;
        this.onMessage = opts.onMessage;
        this.onClose = opts.onClose;
        this.onError = opts.onError;
        this.onDebug = opts.onDebug ?? (() => {});
        const PeerConnection = opts.RTCPeerConnection ?? globalThis.RTCPeerConnection;
        if (!PeerConnection) throw new Error("RTCPeerConnection is not available");
        this.pc = new PeerConnection(opts.rtcConfig);
        try {
            this.attachPeerConnectionHandlers();
            this.pc.addEventListener("datachannel", (event) => {
                const channel = event.channel;
                if (this._closed) {
                    channel.close();
                } else if (this.initiator) {
                    channel.close();
                    this.reportError(
                        new Error("Initiator received an unexpected remote data channel"),
                    );
                } else if (channel.label !== this.channelLabel) {
                    channel.close();
                    this.reportError(
                        new Error(
                            `Expected data channel label ${JSON.stringify(this.channelLabel)}, received ${JSON.stringify(channel.label)}`,
                        ),
                    );
                } else if (this._channel) {
                    channel.close();
                    this.reportError(new Error("Received an unexpected additional data channel"));
                } else {
                    this.attachChannel(channel);
                }
            });

            if (this.initiator) {
                this.attachChannel(
                    this.pc.createDataChannel(this.channelLabel, {
                        ordered: true,
                        ...opts.channelOptions,
                    }),
                );
            }
        } catch (error) {
            this._closed = true;
            try {
                this.pc.close();
            } catch {
                // Preserve the initialization error if closing the partial connection also fails.
            }
            throw error;
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
        this.ensureOpen();
        const offer = await this.pc.createOffer();
        this.ensureOpen();
        await this.pc.setLocalDescription(offer);
        this.ensureOpen();
        await this.waitForIceGatheringComplete();
        this.ensureOpen();
        return descriptionToJSON(this.pc.localDescription);
    }

    async acceptOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
        this.ensureOpen();
        await this.pc.setRemoteDescription(offer);
        this.ensureOpen();
        const answer = await this.pc.createAnswer();
        this.ensureOpen();
        await this.pc.setLocalDescription(answer);
        this.ensureOpen();
        await this.waitForIceGatheringComplete();
        this.ensureOpen();
        return descriptionToJSON(this.pc.localDescription);
    }

    async acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
        this.ensureOpen();
        await this.pc.setRemoteDescription(answer);
        this.ensureOpen();
    }

    send(data: Uint8Array<ArrayBuffer>): boolean {
        if (this._closed || !this._channel || this._channel.readyState !== "open") return false;
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
        if (this._channel.bufferedAmount + data.byteLength > this.maxBufferedAmount) {
            this.reportError(
                new Error(
                    `WebRTC buffered data would exceed the ${this.maxBufferedAmount}-byte limit`,
                ),
            );
            return false;
        }
        try {
            this._channel.send(data);
            return true;
        } catch (error) {
            this.reportError(error);
            return false;
        }
    }

    destroy(): void {
        if (this._closed) return;
        this._closed = true;
        const cleanupErrors: unknown[] = [];
        for (const cancel of this.iceWaits) cancel(closedPeerError());
        try {
            this._channel?.close();
        } catch (error) {
            cleanupErrors.push(error);
        }
        try {
            this.pc.close();
        } catch (error) {
            cleanupErrors.push(error);
        }
        for (const error of cleanupErrors) this.reportError(error);
        this.onClose(this);
    }

    private attachPeerConnectionHandlers(): void {
        this.pc.addEventListener("connectionstatechange", () => {
            if (this._closed) return;
            this.reportDebug({ type: "rtc-connection-state", state: this.pc.connectionState });
            if (this.pc.connectionState === "failed" || this.pc.connectionState === "closed") {
                this.destroy();
            }
        });
        this.pc.addEventListener("iceconnectionstatechange", () => {
            if (this._closed) return;
            this.reportDebug({
                type: "rtc-ice-connection-state",
                state: this.pc.iceConnectionState,
            });
            if (
                this.pc.iceConnectionState === "failed" ||
                this.pc.iceConnectionState === "closed"
            ) {
                this.destroy();
            }
        });
    }

    private attachChannel(channel: RTCDataChannel): void {
        if (this._closed || this._channel) {
            channel.close();
            return;
        }
        this._channel = channel;
        channel.binaryType = "arraybuffer";
        channel.addEventListener("open", () => {
            if (!this._closed && this._channel === channel) this.onOpen(this);
        });
        channel.addEventListener("message", (event) => {
            if (this._closed || this._channel !== channel) return;
            if (event.data instanceof ArrayBuffer) {
                this.onMessage(this, event.data);
            } else {
                this.reportError(new Error("Expected an ArrayBuffer data channel message"));
            }
        });
        channel.addEventListener("close", () => {
            if (!this._closed && this._channel === channel) this.destroy();
        });
        channel.addEventListener("error", (event) => {
            if (!this._closed && this._channel === channel) {
                this.reportError((event as RTCErrorEvent).error ?? event);
            }
        });
    }

    private waitForIceGatheringComplete(): Promise<void> {
        this.ensureOpen();
        if (this.pc.iceGatheringState === "complete") return Promise.resolve();

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => done(), this.iceGatheringTimeout);
            const done = (error?: Error): void => {
                clearTimeout(timeout);
                this.pc.removeEventListener("icegatheringstatechange", onStateChange);
                this.iceWaits.delete(done);
                if (error) reject(error);
                else resolve();
            };
            const onStateChange = (): void => {
                if (this.pc.iceGatheringState === "complete") done();
            };
            this.iceWaits.add(done);
            this.pc.addEventListener("icegatheringstatechange", onStateChange);
        });
    }

    private reportError(error: unknown): void {
        try {
            this.onError(this, error);
        } catch {
            // Error callbacks are diagnostic and must not alter transport control flow.
        }
    }

    private reportDebug(event: Record<string, unknown>): void {
        try {
            this.onDebug(event);
        } catch {
            // Debug callbacks are diagnostic and must not alter transport control flow.
        }
    }

    private ensureOpen(): void {
        if (this._closed) throw closedPeerError();
    }
}

const closedPeerError = (): Error => new Error("WebRTC data peer is closed");

const validateChannelOptions = (
    options: Omit<RTCDataChannelInit, "negotiated" | "id"> | undefined,
): void => {
    if (!options) return;
    const runtimeOptions = options as RTCDataChannelInit;
    if ("negotiated" in runtimeOptions) {
        throw new TypeError("channelOptions.negotiated is unsupported");
    }
    if ("id" in runtimeOptions) throw new TypeError("channelOptions.id is unsupported");
};

const validateTimeout = (name: string, value: number): number => {
    if (typeof value !== "number") throw new TypeError(`${name} must be a number`);
    if (!Number.isFinite(value) || value < 0 || value > maximumTimerDelay) {
        throw new RangeError(`${name} must be between 0 and ${maximumTimerDelay}`);
    }
    return value;
};

const validateLimit = (name: string, value: number): number => {
    if (typeof value !== "number") throw new TypeError(`${name} must be a number`);
    if (Number.isNaN(value) || value < 0) {
        throw new RangeError(`${name} must be non-negative or Infinity`);
    }
    return value;
};

const descriptionToJSON = (
    description: RTCSessionDescription | null,
): RTCSessionDescriptionInit => {
    if (!description) throw new Error("Missing local RTC session description");
    return description.toJSON();
};
