import assert from "node:assert/strict";
import test from "node:test";

class FakeDataChannel {
    binaryType = "blob";
    readyState = "connecting";
    listeners = new Map();
    sent = [];

    addEventListener(type, listener) {
        this.listeners.set(type, listener);
    }
    dispatch(type, event = {}) {
        this.listeners.get(type)?.(event);
    }
    send(data) {
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
    localDescription = null;
    remoteDescription = null;
    listeners = new Map();
    channel = new FakeDataChannel();

    constructor(config) {
        this.config = config;
    }
    addEventListener(type, listener) {
        this.listeners.set(type, listener);
    }
    removeEventListener(type, listener) {
        if (this.listeners.get(type) === listener) this.listeners.delete(type);
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
