import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  GEMINI_LIVE_SYSTEM_PICKER_OPTIONS,
  bindGeminiLiveDisplayMediaDocument,
} from "./display-media-contract.js";

class FakeFrame {
  readonly parent = null;
  readonly sent: Array<{ channel: string; payload: unknown }> = [];
  detached = false;
  destroyed = false;

  constructor(
    readonly processId: number,
    readonly routingId: number,
    readonly frameToken: string,
    readonly url: string,
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

function invokeEvent(sender: FakeWebContents, frame: FakeFrame): Electron.IpcMainInvokeEvent {
  return {
    sender,
    senderFrame: frame,
    processId: frame.processId,
    frameId: frame.routingId,
  } as unknown as Electron.IpcMainInvokeEvent;
}

function displayRequest(
  frame: FakeFrame,
  overrides: Partial<Electron.DisplayMediaRequestHandlerHandlerRequest> = {},
): Electron.DisplayMediaRequestHandlerHandlerRequest {
  return {
    frame: frame as unknown as Electron.WebFrameMain,
    securityOrigin: "https://127.0.0.1:4143",
    videoRequested: true,
    audioRequested: false,
    userGesture: true,
    ...overrides,
  };
}

test("Electron 43 system picker option is explicitly enabled for its available macOS path", () => {
  assert.deepEqual(GEMINI_LIVE_SYSTEM_PICKER_OPTIONS, { useSystemPicker: true });
});

test("binds both custom-picker and system-picker permission admission to one exact document", () => {
  const frame = new FakeFrame(10, 20, "document-one", "https://127.0.0.1:4143/main-window.html");
  const sender = new FakeWebContents(7, frame);
  const binding = bindGeminiLiveDisplayMediaDocument(invokeEvent(sender, frame));

  assert.equal(binding.allowsDisplayRequest(displayRequest(frame)), true);
  assert.equal(
    binding.allowsPermissionRequest(sender as unknown as Electron.WebContents, "display-capture", {
      isMainFrame: true,
      requestingUrl: frame.url,
    }),
    true,
  );
  assert.match(binding.documentId, /^10:20:document-one$/u);

  assert.equal(binding.allowsDisplayRequest(displayRequest(frame, { userGesture: false })), false);
  assert.equal(
    binding.allowsDisplayRequest(displayRequest(frame, { audioRequested: true })),
    false,
  );
  assert.equal(
    binding.allowsPermissionRequest(sender as unknown as Electron.WebContents, "media", {
      isMainFrame: true,
      requestingUrl: frame.url,
    }),
    false,
  );
  assert.equal(
    binding.allowsPermissionRequest(sender as unknown as Electron.WebContents, "display-capture", {
      isMainFrame: false,
      requestingUrl: frame.url,
    }),
    false,
  );
});

test("navigation, replacement frames, and unrelated WebContents fail closed", () => {
  const frame = new FakeFrame(10, 20, "document-one", "file:///Aiden/main-window.html");
  const sender = new FakeWebContents(7, frame);
  const binding = bindGeminiLiveDisplayMediaDocument(invokeEvent(sender, frame));
  const replacement = new FakeFrame(10, 21, "document-two", "file:///Aiden/main-window.html");
  const unrelated = new FakeWebContents(8, replacement);

  assert.equal(binding.allowsDisplayRequest(displayRequest(replacement)), false);
  sender.mainFrame = replacement;
  assert.equal(
    binding.allowsPermissionRequest(sender as unknown as Electron.WebContents, "display-capture", {
      isMainFrame: true,
      requestingUrl: replacement.url,
    }),
    false,
  );
  assert.equal(
    binding.allowsPermissionRequest(
      unrelated as unknown as Electron.WebContents,
      "display-capture",
      { isMainFrame: true, requestingUrl: frame.url },
    ),
    false,
  );

  sender.emit("did-navigate");
  assert.equal(binding.owner.isDestroyed(), true);
  assert.equal(binding.allowsDisplayRequest(displayRequest(frame)), false);
  assert.equal(
    binding.allowsPermissionRequest(sender as unknown as Electron.WebContents, "display-capture", {
      isMainFrame: true,
      requestingUrl: frame.url,
    }),
    false,
  );
});
