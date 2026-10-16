# webrtc-data-peer agent notes

- Keep this a narrow browser-native, single-binary-data-channel transport—not a `simple-peer` replacement.
- Do not add signaling, peer identity, discovery, retries, glare handling, media, renegotiation, Node streams, or bundled WebRTC implementations.
- Signaling is complete/non-trickle SDP. ICE timeout intentionally returns the current description instead of rejecting.
- Provider-specific channel labels, RTC defaults, and connection policy belong in consumers. Channels are in-band only; `negotiated: false` is forced because `Omit` cannot keep it out of structurally typed options.
- `pc` is public so consumers can observe connection state, stats, and SCTP details. Do not add callbacks that mirror `RTCPeerConnection` events.
- Preserve injectable `RTCPeerConnection`, idempotent close notification, boolean `send()`, and rejection of pending negotiation on `destroy()`. Native negotiation operations already in flight may remain pending after close, so each step races destruction.
- Keep explicit `createOffer()`/`createAnswer()`: `@roamhq/wrtc` 0.10.0 rejects implicit and type-only `setLocalDescription()`.
- `onError` is diagnostic: swallow its exceptions. Exceptions from other callbacks propagate. Firefox reports a normal remote close as `User-Initiated Abort` with a null `sctpCauseCode`; it is documented, not filtered.
- Keep `_closed` guards in event listeners. Chromium delivers queued messages after close, and consumer listeners on the public `pc`/`channel` can call `destroy()` mid-dispatch.
- Do not guard against what browsers already guarantee: `close()` does not throw, and `connectionState` reflects ICE failure (Firefox 113+).
- Pass explicit test filenames to `node --test`; a directory argument can pass with zero tests.
- Unit tests mock only `setTimeout`, so `await new Promise(setImmediate)` can flush negotiation steps.
- Run `npm run format` and `npm run check`. For negotiation or channel-lifecycle changes, also run `npm run test:browser` with `BROWSER=chromium` and `BROWSER=firefox`.
- Keep this file limited to important, durable, non-obvious decisions.
