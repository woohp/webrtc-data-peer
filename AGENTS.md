# webrtc-data-peer agent guide

`webrtc-data-peer` wraps one browser-native, binary `RTCDataChannel` and complete (non-trickle) SDP offer/answer. It is a narrow transport, not a `simple-peer` replacement. The whole implementation is `src/index.ts`.

## Scope

- Do not add signaling, peer identity, discovery, retries, glare handling, media, renegotiation, Node streams, or bundled WebRTC implementations.
- Provider-specific channel labels, RTC defaults, and connection policy belong in consumers.
- `pc` is public on purpose. Consumers read connection/ICE state, stats, and SCTP details from it. Do not add callbacks or debug events that mirror `RTCPeerConnection` events.
- Keep the public surface to `pc`, `channel`, `closed`, `connected`, the negotiation methods, `send()`, and `destroy()`. Options and callbacks stay private.

## Behavior contracts

- `send()` returns a boolean and never throws: `false` for a closed/unopened channel, an exceeded limit, or a throwing `channel.send()`. Failures also go to `onError`.
- `onError` exceptions are swallowed so diagnostics cannot change control flow. `onOpen`, `onMessage`, and `onClose` exceptions propagate.
- `destroy()` is idempotent and calls `onClose` exactly once. Remote channel close and `connectionState === "failed"` both route through it.
- ICE gathering timeout resolves with the current local description instead of rejecting.
- `destroy()` rejects pending negotiation: `ensureOpen()` follows every `await` in the negotiation methods, and active ICE waits are cancelled.
- The initiator always creates the channel with `negotiated: false`; responders accept only the first remote channel whose label matches and close the rest.
- `RTCPeerConnection` stays injectable for tests and non-browser runtimes.

## Platform assumptions

Rely on WebRTC spec behavior rather than guarding against it:

- `RTCDataChannel.close()` and `RTCPeerConnection.close()` do not throw, and `pc.close()` fires no state-change events. Do not wrap them in try/catch or listen for `"closed"` states.
- `connectionState` already aggregates ICE failure, so do not add an `iceconnectionstatechange` handler. This assumes Firefox 113+.
- Validate only semantic ranges the type system cannot express. The ICE timeout's `2147483647` upper bound exists because larger `setTimeout` delays overflow and fire immediately.

## Testing

- `test/index.test.js` drives the built `dist/` output with `FakePeerConnection`/`FakeDataChannel`. Extend those fakes instead of adding mocking libraries or per-test infrastructure, and assert outcomes rather than call sequences.
- To let negotiation reach its ICE wait, flush with `await new Promise(setImmediate)`, not a counted series of `await Promise.resolve()`. Mock only `setTimeout` so `setImmediate` still runs.
- `browser-test/index.js` runs a real Chromium/Firefox negotiation through Playwright. Pass test files to `node --test` explicitly: a bare directory argument is treated as a glob, matches nothing, and passes with zero tests.

## Commands

- Format: `npm run format`
- Final check (lint, build, unit tests): `npm run check`
- Browser test: `BROWSER=chromium npm run test:browser` (or `firefox`; run `npx playwright install <browser>` first if needed)

Run `npm run format` and `npm run check` after code changes. Run the browser test when changing negotiation, channel lifecycle, or anything else the fakes cannot model.
