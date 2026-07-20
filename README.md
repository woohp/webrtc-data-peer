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

This package handles a single binary data channel, offer/answer creation, ICE gathering, and lifecycle normalization. Channels are reliable and ordered by default; `channelOptions` may override ordering or retransmission behavior. Only in-band channel negotiation is supported, so `channelOptions.negotiated` and `channelOptions.id` are rejected. An answering peer accepts only the first remote data channel whose label matches `channelLabel`; mismatched and additional channels are closed. It deliberately does not provide signaling, peer IDs, discovery, retries, glare handling, media, renegotiation, Node streams, or WebRTC implementations.

Offers and answers wait until ICE gathering completes or `iceGatheringTimeout` elapses (default `5000` ms). The timeout must be a finite, non-negative number; `0` requests an immediate fallback. A timeout returns the current local description rather than rejecting. Destroying the peer cancels active ICE waits and causes pending negotiation to reject. Supply `RTCPeerConnection` for tests or non-browser runtimes.

`send()` returns `false` when the channel is not open, sending throws, or a configured transport limit is exceeded. Exceptions thrown by `onError` and `onDebug` are isolated so diagnostics cannot alter transport control flow; exceptions from `onOpen`, `onMessage`, and `onClose` are not isolated. Set `fallbackMaxMessageSize` to bound messages when SCTP does not report a negotiated limit, and `maxBufferedAmount` to reject sends that would exceed a data-channel buffering ceiling. Limits must be non-negative numbers; `0` is allowed and `Infinity` disables that safeguard. Both safeguards default to `Infinity`; signaling and application retry policy remain the caller's responsibility.
