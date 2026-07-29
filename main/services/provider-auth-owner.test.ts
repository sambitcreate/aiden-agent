import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { ProviderAuthRequestError } from "./provider-auth-flow-core.js";
import { providerAuthOwner } from "./provider-auth-owner.js";

class FakeFrame {
  readonly parent = null;
  readonly sent: Array<{ channel: string; payload: unknown }> = [];
  detached = false;
  destroyed = false;

  constructor(
    readonly processId: number,
    readonly routingId: number,
    readonly frameToken: string,
  ) {}

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }
}

class FakeWebContents extends EventEmitter {
  destroyed = false;

  constructor(
    readonly id: number,
    public mainFrame: FakeFrame,
  ) {
    super();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

function invokeEvent(
  sender: FakeWebContents,
  senderFrame: FakeFrame | null,
): Electron.IpcMainInvokeEvent {
  return {
    sender,
    senderFrame,
    processId: senderFrame?.processId ?? -1,
    frameId: senderFrame?.routingId ?? -1,
  } as unknown as Electron.IpcMainInvokeEvent;
}

test("binds notifications to the exact invoking frame, not the mutable WebContents target", () => {
  const original = new FakeFrame(10, 20, "old-document");
  const sender = new FakeWebContents(1, original);
  const owner = providerAuthOwner(invokeEvent(sender, original));

  owner.send("providers:auth:prompt", { promptId: "one" });
  assert.deepEqual(original.sent, [
    { channel: "providers:auth:prompt", payload: { promptId: "one" } },
  ]);

  const replacement = new FakeFrame(10, 21, "new-document");
  sender.mainFrame = replacement;
  assert.equal(owner.isDestroyed(), true);
  assert.throws(() => owner.send("providers:auth:prompt", {}), /no longer active/u);
  assert.deepEqual(replacement.sent, []);
});

test("rejects a start IPC queued from a document that navigation already replaced", () => {
  const oldFrame = new FakeFrame(10, 20, "old-document");
  const currentFrame = new FakeFrame(10, 21, "new-document");
  const sender = new FakeWebContents(1, currentFrame);

  assert.throws(() => providerAuthOwner(invokeEvent(sender, oldFrame)), ProviderAuthRequestError);
  assert.throws(() => providerAuthOwner(invokeEvent(sender, null)), ProviderAuthRequestError);
});

test("remembers committed navigation without requiring an invalidation subscriber", () => {
  const frame = new FakeFrame(10, 20, "document");
  const sender = new FakeWebContents(1, frame);
  const owner = providerAuthOwner(invokeEvent(sender, frame));

  sender.emit("did-navigate");

  assert.equal(owner.isDestroyed(), true);
  assert.throws(() => owner.send("providers:auth:prompt", {}), /no longer active/u);
});

test("keeps auth alive for prevented provisional links and invalidates committed navigation", () => {
  const frame = new FakeFrame(10, 20, "document");
  const sender = new FakeWebContents(1, frame);
  const owner = providerAuthOwner(invokeEvent(sender, frame));
  let invalidations = 0;
  const remove = owner.onInvalidated(() => {
    invalidations += 1;
  });

  sender.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: false,
    url: "https://auth.openai.com/",
  });
  assert.equal(invalidations, 0);
  assert.equal(owner.isDestroyed(), false);

  sender.emit("did-navigate");
  assert.equal(invalidations, 1);
  assert.equal(owner.isDestroyed(), true);
  assert.throws(() => owner.send("providers:auth:prompt", {}), /no longer active/u);

  sender.emit("did-navigate");
  sender.emit("render-process-gone");
  assert.equal(invalidations, 1);
  remove();
});

test("delayed subagent delivery cannot cross a committed same-frame navigation", async () => {
  const frame = new FakeFrame(10, 20, "document");
  const sender = new FakeWebContents(1, frame);
  const owner = providerAuthOwner(invokeEvent(sender, frame));
  const remove = owner.onInvalidated(() => undefined);
  let releasePersistence!: () => void;
  const persistence = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  const delivery = (async () => {
    await persistence;
    owner.send("chat:subagents", { streamId: "generation-one" });
  })();

  sender.emit("did-navigate");
  releasePersistence();

  await assert.rejects(delivery, /no longer active/u);
  assert.deepEqual(frame.sent, []);
  remove();
});

test("renderer process loss invalidates the captured document once", () => {
  const frame = new FakeFrame(10, 20, "document");
  const sender = new FakeWebContents(1, frame);
  const owner = providerAuthOwner(invokeEvent(sender, frame));
  let invalidations = 0;
  const remove = owner.onInvalidated(() => {
    invalidations += 1;
  });

  sender.emit("render-process-gone");
  sender.emit("destroyed");
  assert.equal(invalidations, 1);
  remove();
});

test("one throwing document invalidation cannot starve later revocation callbacks", () => {
  const frame = new FakeFrame(10, 20, "document");
  const sender = new FakeWebContents(1, frame);
  const first = providerAuthOwner(invokeEvent(sender, frame));
  const second = providerAuthOwner(invokeEvent(sender, frame));
  let laterInvalidations = 0;
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    first.onInvalidated(() => {
      throw new Error("simulated terminal teardown failure");
    });
    second.onInvalidated(() => {
      laterInvalidations += 1;
    });

    assert.doesNotThrow(() => sender.emit("did-navigate"));
    sender.emit("render-process-gone");
    sender.emit("destroyed");
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(laterInvalidations, 1);
  assert.equal(first.isDestroyed(), true);
  assert.equal(second.isDestroyed(), true);
});
