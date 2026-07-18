# webrtc-data-peer agent notes

- Keep this a narrow browser-native, single-binary-data-channel transport—not a `simple-peer` replacement.
- Do not add signaling, peer identity, discovery, retries, glare handling, media, renegotiation, Node streams, or bundled WebRTC implementations.
- Signaling is complete/non-trickle SDP. ICE timeout intentionally returns the current description instead of rejecting.
- Provider-specific channel labels, RTC defaults, and connection policy belong in consumers.
- Preserve injectable `RTCPeerConnection`, idempotent close notification, and boolean `send()` semantics.
- Run `npm run format` and `npm run check`.
- Keep this file limited to important, durable, non-obvious decisions.
