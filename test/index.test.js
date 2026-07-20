import assert from "node:assert/strict";
import test from "node:test";

class FakeDataChannel {
    binaryType = "blob";
    readyState = "connecting";
    bufferedAmount = 0;
    listeners = new Map();
    sent = [];
    sendError = null;

    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }
    dispatch(type, event = {}) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    send(data) {
        if (this.sendError) throw this.sendError;
        this.sent.push(data);
    }
    close() {
        this.readyState = "closed";
        this.dispatch("close");
    }
}

class FakePeerConnection {
    connectionState = "new";
    iceConnectionState = "new";
    iceGatheringState = "complete";
    sctp = null;
    localDescription = null;
    remoteDescription = null;
    listeners = new Map();
    channel = new FakeDataChannel();

    constructor(config) {
        this.config = config;
    }
    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }
    removeEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        this.listeners.set(
            type,
            listeners.filter((candidate) => candidate !== listener),
        );
    }
    dispatch(type, event = {}) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    createDataChannel(label, options) {
        this.channel.label = label;
        this.channel.options = options;
        return this.channel;
    }
    async createOffer() {
        return { type: "offer", sdp: "offer" };
    }
    async createAnswer() {
        return { type: "answer", sdp: "answer" };
    }
    async setLocalDescription(description) {
        this.localDescription = { ...description, toJSON: () => ({ ...description }) };
    }
    async setRemoteDescription(description) {
        this.remoteDescription = description;
    }
    close() {
        this.connectionState = "closed";
        this.iceConnectionState = "closed";
    }
}

const { WebrtcDataPeer } = await import("../dist/index.js");

const createPeer = (overrides = {}) => {
    const events = { opens: 0, closes: 0, messages: [], errors: [] };
    const peer = new WebrtcDataPeer({
        initiator: true,
        channelLabel: "test-channel",
        RTCPeerConnection: FakePeerConnection,
        onOpen: () => events.opens++,
        onMessage: (_peer, data) => events.messages.push(data),
        onClose: () => events.closes++,
        onError: (_peer, error) => events.errors.push(error),
        ...overrides,
    });
    return { peer, events };
};

test("creates complete offers and accepts answers", async () => {
    const { peer } = createPeer();
    assert.deepEqual(await peer.createOffer(), { type: "offer", sdp: "offer" });
    await peer.acceptAnswer({ type: "answer", sdp: "answer" });
    assert.deepEqual(peer.pc.remoteDescription, { type: "answer", sdp: "answer" });
    assert.equal(peer.channel.label, "test-channel");
    assert.deepEqual(peer.channel.options, { ordered: true });
    peer.destroy();
});

test("answers offers", async () => {
    const { peer } = createPeer({ initiator: false });
    assert.equal(peer.channel, null);
    assert.deepEqual(await peer.acceptOffer({ type: "offer", sdp: "offer" }), {
        type: "answer",
        sdp: "answer",
    });
    assert.deepEqual(peer.pc.remoteDescription, { type: "offer", sdp: "offer" });
    peer.destroy();
});

test("reports data channel lifecycle and send outcome", () => {
    const { peer, events } = createPeer();
    assert.equal(peer.send(new Uint8Array([1])), false);

    peer.channel.readyState = "open";
    peer.channel.dispatch("open");
    assert.equal(events.opens, 1);
    assert.equal(peer.send(new Uint8Array([1, 2])), true);
    assert.deepEqual(peer.channel.sent[0], new Uint8Array([1, 2]));

    const message = new Uint8Array([3, 4]).buffer;
    peer.channel.dispatch("message", { data: message });
    assert.deepEqual(events.messages, [message]);

    peer.destroy();
    peer.destroy();
    assert.equal(events.closes, 1);
});

test("rejects non-binary messages", () => {
    const { peer, events } = createPeer();
    peer.channel.dispatch("message", { data: "text" });
    assert.equal(events.errors.length, 1);
    peer.destroy();
});
test("enforces configured message and buffered-byte limits", () => {
    const { peer, events } = createPeer({
        fallbackMaxMessageSize: 2,
        maxBufferedAmount: 4,
    });
    peer.channel.readyState = "open";

    assert.equal(peer.send(new Uint8Array(3)), false);
    assert.match(String(events.errors.at(-1)), /3 bytes.*2-byte limit/);

    peer.pc.sctp = { maxMessageSize: 2 };
    assert.equal(peer.send(new Uint8Array(2)), true);
    assert.equal(peer.send(new Uint8Array(3)), false);
    assert.match(String(events.errors.at(-1)), /3 bytes.*2-byte limit/);

    peer.pc.sctp = { maxMessageSize: 0 };
    peer.channel.bufferedAmount = 2;
    assert.equal(peer.send(new Uint8Array(2)), true);
    peer.channel.bufferedAmount = 3;
    assert.equal(peer.send(new Uint8Array(2)), false);
    assert.match(String(events.errors.at(-1)), /buffered data.*4-byte limit/);
    peer.destroy();
});

test("reports data channel send exceptions", () => {
    const { peer, events } = createPeer();
    peer.channel.readyState = "open";
    peer.channel.sendError = new Error("send failed");

    assert.equal(peer.send(new Uint8Array([1])), false);
    assert.equal(events.errors[0], peer.channel.sendError);
    peer.destroy();
    assert.equal(peer.connected, false);
    assert.equal(peer.send(new Uint8Array([1])), false);
});

test("initiator rejects every remotely created data channel", () => {
    const { peer, events } = createPeer();
    const owned = peer.channel;
    const remote = new FakeDataChannel();
    remote.label = "test-channel";

    peer.pc.dispatch("datachannel", { channel: remote });

    assert.equal(remote.readyState, "closed");
    assert.equal(peer.channel, owned);
    assert.match(String(events.errors[0]), /Initiator received an unexpected/);
    peer.destroy();
});

test("closes the peer connection when channel creation throws", () => {
    class ThrowingChannelPeerConnection extends FakePeerConnection {
        static latest;
        constructor(config) {
            super(config);
            ThrowingChannelPeerConnection.latest = this;
        }
        createDataChannel() {
            throw new Error("channel creation failed");
        }
    }

    assert.throws(
        () => createPeer({ RTCPeerConnection: ThrowingChannelPeerConnection }),
        /channel creation failed/,
    );
    assert.equal(ThrowingChannelPeerConnection.latest.connectionState, "closed");
    assert.equal(ThrowingChannelPeerConnection.latest.iceConnectionState, "closed");
});
test("responder owns only the first matching data channel", () => {
    const { peer, events } = createPeer({ initiator: false });
    const mismatched = new FakeDataChannel();
    mismatched.label = "other-channel";
    peer.pc.dispatch("datachannel", { channel: mismatched });
    assert.equal(mismatched.readyState, "closed");
    assert.equal(peer.channel, null);
    assert.equal(events.errors.length, 1);

    const expected = new FakeDataChannel();
    expected.label = "test-channel";
    peer.pc.dispatch("datachannel", { channel: expected });
    assert.equal(peer.channel, expected);
    expected.readyState = "open";
    expected.dispatch("open");
    assert.equal(events.opens, 1);

    const duplicate = new FakeDataChannel();
    duplicate.label = "test-channel";
    peer.pc.dispatch("datachannel", { channel: duplicate });
    assert.equal(duplicate.readyState, "closed");
    assert.equal(peer.channel, expected);
    assert.equal(events.errors.length, 2);
    peer.destroy();

    const afterDestroy = new FakeDataChannel();
    afterDestroy.label = "test-channel";
    peer.pc.dispatch("datachannel", { channel: afterDestroy });
    assert.equal(afterDestroy.readyState, "closed");
    assert.equal(events.errors.length, 2);
});

test("owned channel callbacks are ignored after destroy", () => {
    const { peer, events } = createPeer();
    const channel = peer.channel;
    peer.destroy();

    channel.dispatch("open");
    channel.dispatch("message", { data: new ArrayBuffer(1) });
    channel.dispatch("error", new Error("late error"));

    assert.equal(events.closes, 1);
    assert.equal(events.opens, 0);
    assert.deepEqual(events.messages, []);
    assert.deepEqual(events.errors, []);
});

test("rejects unsupported out-of-band channel options", () => {
    for (const negotiated of [true, false]) {
        assert.throws(
            () => createPeer({ channelOptions: { negotiated } }),
            /channelOptions\.negotiated is unsupported/,
        );
    }
    assert.throws(
        () => createPeer({ channelOptions: { id: 7 } }),
        /channelOptions\.id is unsupported/,
    );
});

test("send remains boolean when the error callback throws", () => {
    const throwingOnError = () => {
        throw new Error("callback failed");
    };
    const { peer: oversizedPeer } = createPeer({
        fallbackMaxMessageSize: 1,
        onError: throwingOnError,
    });
    oversizedPeer.channel.readyState = "open";
    assert.equal(oversizedPeer.send(new Uint8Array(2)), false);
    oversizedPeer.destroy();

    const { peer: failingPeer } = createPeer({ onError: throwingOnError });
    failingPeer.channel.readyState = "open";
    failingPeer.channel.sendError = new Error("send failed");
    assert.equal(failingPeer.send(new Uint8Array(1)), false);
    failingPeer.destroy();
});

test("throwing debug callbacks cannot prevent failed-state teardown", () => {
    const { peer, events } = createPeer({
        onDebug: () => {
            throw new Error("debug failed");
        },
    });

    peer.pc.connectionState = "failed";
    peer.pc.dispatch("connectionstatechange");

    assert.equal(peer.closed, true);
    assert.equal(events.closes, 1);
});
test("validates the ICE gathering timeout", () => {
    for (const value of [
        "1",
        Number.NaN,
        -1,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        2_147_483_648,
    ]) {
        assert.throws(() => createPeer({ iceGatheringTimeout: value }), /iceGatheringTimeout/);
    }

    for (const value of [0, 2_147_483_647]) {
        const { peer } = createPeer({ iceGatheringTimeout: value });
        assert.equal(peer.iceGatheringTimeout, value);
        peer.destroy();
    }
});

test("validates numeric send limits", () => {
    for (const [option, value, ErrorType] of [
        ["fallbackMaxMessageSize", Number.NaN, RangeError],
        ["fallbackMaxMessageSize", -1, RangeError],
        ["fallbackMaxMessageSize", -Infinity, RangeError],
        ["maxBufferedAmount", Number.NaN, RangeError],
        ["maxBufferedAmount", -1, RangeError],
        ["maxBufferedAmount", "1", TypeError],
    ]) {
        assert.throws(() => createPeer({ [option]: value }), ErrorType);
    }
    const { peer } = createPeer({ fallbackMaxMessageSize: 0, maxBufferedAmount: Infinity });
    peer.destroy();
});

test("destroy cancels active ICE waits", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const { peer, events } = createPeer({ iceGatheringTimeout: 1000 });
    peer.pc.iceGatheringState = "gathering";
    const creatingOffer = peer.createOffer();
    await Promise.resolve();
    await Promise.resolve();

    peer.destroy();

    await assert.rejects(creatingOffer, /WebRTC data peer is closed/);
    assert.deepEqual(peer.pc.listeners.get("icegatheringstatechange"), []);
    assert.equal(events.closes, 1);
});

test("negotiation cannot complete after destroy", async () => {
    let resolveOffer;
    class DeferredOfferPeerConnection extends FakePeerConnection {
        createOffer() {
            return new Promise((resolve) => (resolveOffer = resolve));
        }
    }
    const { peer } = createPeer({ RTCPeerConnection: DeferredOfferPeerConnection });
    const creatingOffer = peer.createOffer();
    peer.destroy();
    resolveOffer({ type: "offer", sdp: "late" });

    await assert.rejects(creatingOffer, /WebRTC data peer is closed/);
});

test("throwing cleanup still closes once and reports each error", () => {
    const { peer, events } = createPeer();
    peer.channel.close = () => {
        throw new Error("channel close failed");
    };
    peer.pc.close = () => {
        throw new Error("peer connection close failed");
    };

    peer.destroy();
    peer.destroy();

    assert.equal(events.closes, 1);
    assert.deepEqual(events.errors.map(String), [
        "Error: channel close failed",
        "Error: peer connection close failed",
    ]);
});

test("data channel errors expose the underlying RTC error", () => {
    const { peer, events } = createPeer();
    const error = new Error("RTC failure");

    peer.channel.dispatch("error", { error });

    assert.equal(events.errors[0], error);
    peer.destroy();
});
test("waits for ICE completion and closes on failed connection state", async () => {
    const { peer, events } = createPeer();
    peer.pc.iceGatheringState = "gathering";
    const creatingOffer = peer.createOffer();
    await Promise.resolve();
    await Promise.resolve();
    peer.pc.iceGatheringState = "complete";
    peer.pc.dispatch("icegatheringstatechange");

    assert.deepEqual(await creatingOffer, { type: "offer", sdp: "offer" });
    peer.pc.connectionState = "failed";
    peer.pc.dispatch("connectionstatechange");
    assert.equal(events.closes, 1);
});

test("closes on failed ICE connection state", () => {
    const { peer, events } = createPeer();
    peer.pc.iceConnectionState = "failed";
    peer.pc.dispatch("iceconnectionstatechange");

    assert.equal(events.closes, 1);
});
test("ICE gathering timeout returns the current description", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const { peer } = createPeer({ iceGatheringTimeout: 100 });
    peer.pc.iceGatheringState = "gathering";
    const creatingOffer = peer.createOffer();
    await Promise.resolve();
    await Promise.resolve();
    context.mock.timers.tick(100);

    assert.deepEqual(await creatingOffer, { type: "offer", sdp: "offer" });
    peer.destroy();
});
