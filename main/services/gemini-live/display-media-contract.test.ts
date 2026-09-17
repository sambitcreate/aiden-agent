import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  GEMINI_LIVE_SYSTEM_PICKER_OPTIONS,
  bindGeminiLiveDisplayMediaDocument,
  installGeminiLiveDisplayMediaGuards,
  type GeminiLiveDisplayMediaBinding,
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
    true,
  );
  assert.equal(
    binding.allowsPermissionRequest(sender as unknown as Electron.WebContents, "display-capture", {
      isMainFrame: false,
      requestingUrl: frame.url,
    }),
    false,
  );
});

test("session guards gate display-capture only and install exactly once", () => {
  const installed = {
    checks: 0,
    requests: 0,
    displays: 0,
    check: null as
      | ((
          webContents: Electron.WebContents | null,
          permission: string,
          requestingOrigin: string,
          details: Electron.PermissionCheckHandlerHandlerDetails,
        ) => boolean)
      | null,
    request: null as
      | ((
          webContents: Electron.WebContents,
          permission: string,
          callback: (granted: boolean) => void,
          details: Electron.PermissionRequest,
        ) => void)
      | null,
    display: null as
      | ((
          request: Electron.DisplayMediaRequestHandlerHandlerRequest,
          callback: (streams: Electron.Streams) => void,
        ) => void)
      | null,
    opts: undefined as Electron.DisplayMediaRequestHandlerOpts | undefined,
  };
  const electronSession = {
    setPermissionCheckHandler(handler: typeof installed.check) {
      installed.checks += 1;
      installed.check = handler;
    },
    setPermissionRequestHandler(handler: typeof installed.request) {
      installed.requests += 1;
      installed.request = handler;
    },
    setDisplayMediaRequestHandler(
      handler: typeof installed.display,
      opts?: Electron.DisplayMediaRequestHandlerOpts,
    ) {
      installed.displays += 1;
      installed.display = handler;
      installed.opts = opts;
    },
  };
  const frame = new FakeFrame(10, 20, "document-one", "file:///Aiden/main-window.html");
  const sender = new FakeWebContents(7, frame);
  const bindings: GeminiLiveDisplayMediaBinding[] = [];
  const dispose = installGeminiLiveDisplayMediaGuards(electronSession, () => bindings);
  assert.equal(
    installGeminiLiveDisplayMediaGuards(electronSession, () => bindings),
    dispose,
  );
  assert.equal(installed.checks, 1, "re-installation must not stack handlers");
  assert.equal(installed.requests, 1);
  assert.equal(installed.displays, 1);
  assert.deepEqual(installed.opts, { useSystemPicker: true });

  const details = { isMainFrame: true, requestingUrl: frame.url } as Electron.PermissionRequest;
  // Without a Live binding every display-capture path denies.
  assert.equal(
    installed.check?.(
      sender as unknown as Electron.WebContents,
      "display-capture",
      "file:///Aiden/",
      details,
    ),
    false,
  );
  let granted: boolean | null = null;
  installed.request?.(
    sender as unknown as Electron.WebContents,
    "display-capture",
    (next) => {
      granted = next;
    },
    details,
  );
  assert.equal(granted, false);

  // A bound document admits only its display capture and microphone. Unrelated
  // contents and unrelated permission types remain denied while the temporary
  // guard owns the session policy.
  bindings.push(bindGeminiLiveDisplayMediaDocument(invokeEvent(sender, frame)));
  assert.equal(
    installed.check?.(
      sender as unknown as Electron.WebContents,
      "display-capture",
      "file:///Aiden/",
      details,
    ),
    true,
  );
  assert.equal(
    installed.check?.(sender as unknown as Electron.WebContents, "media", "file:///Aiden/", details),
    true,
    "the exact bound document keeps microphone access",
  );
  granted = null;
  installed.request?.(sender as unknown as Electron.WebContents, "media", (next) => {
    granted = next;
  }, details);
  assert.equal(granted, true);
  assert.equal(
    installed.check?.(sender as unknown as Electron.WebContents, "notifications", "file:///Aiden/", details),
    false,
  );
  assert.equal(installed.check?.(null, "media", "file:///Aiden/", details), false);

  // Any non-picker dispatch to the fallback handler is denied outright.
  const streams: Electron.Streams[] = [];
  installed.display?.(displayRequest(frame), (next) => streams.push(next));
  assert.deepEqual(streams, [{}]);

  // Releasing the binding closes capture again immediately.
  bindings.pop();
  assert.equal(
    installed.check?.(
      sender as unknown as Electron.WebContents,
      "display-capture",
      "file:///Aiden/",
      details,
    ),
    false,
  );
  dispose();
  assert.equal(installed.check, null);
  assert.equal(installed.request, null);
  assert.equal(installed.display, null);
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
