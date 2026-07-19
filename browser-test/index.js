import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";

test("negotiates a real channel, sends binary data, and closes", { timeout: 30_000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        const source = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");
        const result = await page.evaluate(async (moduleSource) => {
            const moduleUrl = URL.createObjectURL(
                new Blob([moduleSource], { type: "text/javascript" }),
            );
            const { WebrtcDataPeer } = await import(moduleUrl);
            URL.revokeObjectURL(moduleUrl);

            const withTimeout = (promise, label) =>
                Promise.race([
                    promise,
                    new Promise((_, reject) =>
                        setTimeout(
                            () => reject(new Error(`Timed out waiting for ${label}`)),
                            10_000,
                        ),
                    ),
                ]);
            const errors = [];
            let resolveInitiatorOpen;
            let resolveResponderOpen;
            let resolveMessage;
            let resolveResponderClose;
            const initiatorOpen = new Promise((resolve) => (resolveInitiatorOpen = resolve));
            const responderOpen = new Promise((resolve) => (resolveResponderOpen = resolve));
            const message = new Promise((resolve) => (resolveMessage = resolve));
            const responderClose = new Promise((resolve) => (resolveResponderClose = resolve));
            let initiatorCloses = 0;
            let responderCloses = 0;

            const initiator = new WebrtcDataPeer({
                initiator: true,
                channelLabel: "browser-test",
                onOpen: resolveInitiatorOpen,
                onMessage: () => {},
                onClose: () => initiatorCloses++,
                onError: (_peer, error) => errors.push(String(error)),
            });
            const responder = new WebrtcDataPeer({
                initiator: false,
                channelLabel: "browser-test",
                onOpen: resolveResponderOpen,
                onMessage: (_peer, data) => resolveMessage([...new Uint8Array(data)]),
                onClose: () => {
                    responderCloses++;
                    resolveResponderClose();
                },
                onError: (_peer, error) => errors.push(String(error)),
            });

            const offer = await initiator.createOffer();
            const answer = await responder.acceptOffer(offer);
            await initiator.acceptAnswer(answer);
            await withTimeout(Promise.all([initiatorOpen, responderOpen]), "channel open");
            const sent = initiator.send(new Uint8Array([1, 2, 3, 255]));
            const received = await withTimeout(message, "binary message");
            const errorsBeforeClose = [...errors];
            initiator.destroy();
            await withTimeout(responderClose, "remote close");
            responder.destroy();

            return { sent, received, initiatorCloses, responderCloses, errorsBeforeClose };
        }, source);

        assert.deepEqual(result, {
            sent: true,
            received: [1, 2, 3, 255],
            initiatorCloses: 1,
            responderCloses: 1,
            errorsBeforeClose: [],
        });
    } finally {
        await browser.close();
    }
});
