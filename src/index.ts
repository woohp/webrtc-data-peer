export interface WebrtcDataPeerOptions {
    initiator: boolean;
    channelLabel: string;
    channelOptions?: RTCDataChannelInit;
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
    channel: RTCDataChannel | null = null;
    closed = false;

    constructor(opts: WebrtcDataPeerOptions) {
        this.initiator = opts.initiator;
        this.channelLabel = opts.channelLabel;
        this.iceGatheringTimeout = opts.iceGatheringTimeout ?? 5000;
        this.fallbackMaxMessageSize = validateLimit(
            "fallbackMaxMessageSize",
            opts.fallbackMaxMessageSize ?? Number.POSITIVE_INFINITY,
        );
        this.maxBufferedAmount = validateLimit(
            "maxBufferedAmount",
            opts.maxBufferedAmount ?? Number.POSITIVE_INFINITY,
        );
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
                if (this.closed) {
                    channel.close();
                } else if (this.initiator) {
                    channel.close();
                    this.onError(
                        this,
                        new Error("Initiator received an unexpected remote data channel"),
                    );
                } else if (channel.label !== this.channelLabel) {
                    channel.close();
                    this.onError(
                        this,
                        new Error(
                            `Expected data channel label ${JSON.stringify(this.channelLabel)}, received ${JSON.stringify(channel.label)}`,
                        ),
                    );
                } else if (this.channel) {
                    channel.close();
                    this.onError(this, new Error("Received an unexpected additional data channel"));
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
            this.closed = true;
            try {
                this.pc.close();
            } catch {
                // Preserve the initialization error if closing the partial connection also fails.
            }
            throw error;
        }
    }

    get connected(): boolean {
        return !this.closed && this.channel?.readyState === "open";
    }

    async createOffer(): Promise<RTCSessionDescriptionInit> {
        await this.pc.setLocalDescription(await this.pc.createOffer());
        await this.waitForIceGatheringComplete();
        return descriptionToJSON(this.pc.localDescription);
    }

    async acceptOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
        await this.pc.setRemoteDescription(offer);
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        await this.waitForIceGatheringComplete();
        return descriptionToJSON(this.pc.localDescription);
    }

    async acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
        await this.pc.setRemoteDescription(answer);
    }

    send(data: Uint8Array<ArrayBuffer>): boolean {
        if (this.closed || !this.channel || this.channel.readyState !== "open") return false;
        const negotiatedMax = this.pc.sctp?.maxMessageSize;
        const maxMessageSize =
            negotiatedMax === 0
                ? Number.POSITIVE_INFINITY
                : (negotiatedMax ?? this.fallbackMaxMessageSize);
        if (data.byteLength > maxMessageSize) {
            this.onError(
                this,
                new Error(
                    `WebRTC message is ${data.byteLength} bytes, exceeding the ${maxMessageSize}-byte limit`,
                ),
            );
            return false;
        }
        if (this.channel.bufferedAmount + data.byteLength > this.maxBufferedAmount) {
            this.onError(
                this,
                new Error(
                    `WebRTC buffered data would exceed the ${this.maxBufferedAmount}-byte limit`,
                ),
            );
            return false;
        }
        try {
            this.channel.send(data);
            return true;
        } catch (error) {
            this.onError(this, error);
            return false;
        }
    }

    destroy(): void {
        if (this.closed) return;
        this.closed = true;
        this.channel?.close();
        this.pc.close();
        this.onClose(this);
    }

    private attachPeerConnectionHandlers(): void {
        this.pc.addEventListener("connectionstatechange", () => {
            if (this.closed) return;
            this.onDebug({ type: "rtc-connection-state", state: this.pc.connectionState });
            if (this.pc.connectionState === "failed" || this.pc.connectionState === "closed") {
                this.destroy();
            }
        });
        this.pc.addEventListener("iceconnectionstatechange", () => {
            if (this.closed) return;
            this.onDebug({ type: "rtc-ice-connection-state", state: this.pc.iceConnectionState });
            if (
                this.pc.iceConnectionState === "failed" ||
                this.pc.iceConnectionState === "closed"
            ) {
                this.destroy();
            }
        });
    }

    private attachChannel(channel: RTCDataChannel): void {
        if (this.closed || this.channel) {
            channel.close();
            return;
        }
        this.channel = channel;
        channel.binaryType = "arraybuffer";
        channel.addEventListener("open", () => {
            if (!this.closed && this.channel === channel) this.onOpen(this);
        });
        channel.addEventListener("message", (event) => {
            if (this.closed || this.channel !== channel) return;
            if (event.data instanceof ArrayBuffer) {
                this.onMessage(this, event.data);
            } else {
                this.onError(this, new Error("Expected an ArrayBuffer data channel message"));
            }
        });
        channel.addEventListener("close", () => {
            if (!this.closed && this.channel === channel) this.destroy();
        });
        channel.addEventListener("error", (event) => {
            if (!this.closed && this.channel === channel) this.onError(this, event);
        });
    }

    private waitForIceGatheringComplete(): Promise<void> {
        if (this.pc.iceGatheringState === "complete") return Promise.resolve();

        return new Promise((resolve) => {
            const timeout = setTimeout(done, this.iceGatheringTimeout);
            const pc = this.pc;

            function done() {
                clearTimeout(timeout);
                pc.removeEventListener("icegatheringstatechange", onStateChange);
                resolve();
            }

            function onStateChange() {
                if (pc.iceGatheringState === "complete") done();
            }

            pc.addEventListener("icegatheringstatechange", onStateChange);
        });
    }
}

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
