# webrtc-data-peer

Small browser-native wrapper for one WebRTC data channel and complete, non-trickle SDP signaling.

```js
import { WebrtcDataPeer } from "webrtc-data-peer";

const peer = new WebrtcDataPeer({
    initiator: true,
    channelLabel: "my-protocol",
    rtcConfig: { iceServers: [{ urls: "stun:stun.example.org" }] },
    onOpen: () => console.log("connected"),
    onMessage: (_peer, data) => console.log(new Uint8Array(data)),
    onClose: () => console.log("closed"),
    onError: (_peer, error) => console.error(error),
});

const offer = await peer.createOffer();
// Send the offer through your signaling transport and receive an answer.
await peer.acceptAnswer(answer);
```

An answering peer uses `initiator: false` and `acceptOffer()`.

## Scope

This package handles a single reliable binary data channel, offer/answer creation, ICE gathering, and lifecycle normalization. An answering peer accepts only the first remote data channel whose label matches `channelLabel`; mismatched and additional channels are closed. It deliberately does not provide signaling, peer IDs, discovery, retries, glare handling, media, renegotiation, Node streams, or WebRTC implementations.

Offers and answers wait until ICE gathering completes or `iceGatheringTimeout` elapses (default `5000` ms). A timeout returns the current local description rather than rejecting. Supply `RTCPeerConnection` for tests or non-browser runtimes.

`send()` returns `false` when the channel is not open, sending throws, or a configured transport limit is exceeded. Set `fallbackMaxMessageSize` to bound messages when SCTP does not report a negotiated limit, and `maxBufferedAmount` to reject sends that would exceed a data-channel buffering ceiling. Limits must be non-negative numbers; `0` is allowed and `Infinity` disables that safeguard. Both safeguards default to `Infinity`; signaling and application retry policy remain the caller's responsibility.
