// The one owner of the default session's permission handlers and of its
// download and device-chooser events (design mode v2 Phase 3a, D8, S9, S60).
// Electron keeps one handler per kind per session, so Gemini Live's display
// guard and design mode's deny layer can't each set their own.
//
// - The owner slot is what Gemini Live's `DisplayMediaGuardSession` writes to.
//   It is the same object for every call with the same name, because Live's
//   guard keys a WeakMap by it and reinstalls on every binding change.
// - Deny layers say no before the owner is asked; any layer's deny wins, and a
//   layer that throws denies.
// - With no layer the owner's handlers are installed exactly as given (null
//   when there is no owner), so Live behaves as it did before 3a. With a layer
//   a composed handler runs the layers, then the owner, then Electron's own
//   default for that handler (Electron 43 docs): permission checks and
//   requests are granted, a display request with no handler gets no source
//   (`{}`), and a device permission with no handler isn't granted (`false`).
// - `will-download` and `select-{hid-device,serial-port,usb-device}` get an
//   Electron listener only while a subscriber exists.
//
// `check:aiden-rules`' `default-session-owner` rule keeps every other module
// off these; `guardSetters` (non-packaged builds) also stubs the setters.

import type { DisplayMediaGuardSession } from "./gemini-live/display-media-contract.js";

type CheckHandler = (
  webContents: Electron.WebContents | null,
  permission: string,
  requestingOrigin: string,
  details: Electron.PermissionCheckHandlerHandlerDetails,
) => boolean;
type RequestHandler = (
  webContents: Electron.WebContents,
  permission: string,
  callback: (permissionGranted: boolean) => void,
  details: Electron.PermissionRequest,
) => void;
type DisplayHandler = (
  request: Electron.DisplayMediaRequestHandlerHandlerRequest,
  callback: (streams: Electron.Streams) => void,
) => void;
type DeviceHandler = (details: Electron.DevicePermissionHandlerHandlerDetails) => boolean;

export interface PermissionDenyLayer {
  denyCheck?(
    webContents: Electron.WebContents | null,
    permission: string,
    origin: string,
    details: Electron.PermissionCheckHandlerHandlerDetails,
  ): boolean;
  denyRequest?(webContents: Electron.WebContents, permission: string, details: Electron.PermissionRequest): boolean;
  denyDisplay?(request: Electron.DisplayMediaRequestHandlerHandlerRequest): boolean;
  denyDevice?(details: Electron.DevicePermissionHandlerHandlerDetails): boolean;
}

export type WillDownloadHandler = (
  item: Electron.DownloadItem,
  webContents: Electron.WebContents,
  frame: Electron.WebFrameMain | null,
) => "cancel" | undefined;
export type DeviceChooserKind = "hid" | "serial" | "usb";
export type SelectDeviceHandler = (
  kind: DeviceChooserKind,
  /** HID and USB name the frame (null once it navigated or closed); serial names only its web contents. */
  details: { frame: Electron.WebFrameMain | null; webContents?: Electron.WebContents },
) => "cancel" | undefined;

export interface DefaultSessionPermissions {
  /** Gemini Live's DisplayMediaGuardSession; the same object for the same name. */
  ownerSlot(name: string): DisplayMediaGuardSession;
  addDenyLayer(name: string, layer: PermissionDenyLayer): () => void;
  onWillDownload(name: string, handler: WillDownloadHandler): () => void;
  onSelectDevice(name: string, handler: SelectDeviceHandler): () => void;
}

export type PermissionTarget = {
  setPermissionCheckHandler(handler: CheckHandler | null): void;
  setPermissionRequestHandler(handler: RequestHandler | null): void;
  setDisplayMediaRequestHandler(handler: DisplayHandler | null, options?: Electron.DisplayMediaRequestHandlerOpts): void;
  setDevicePermissionHandler(handler: DeviceHandler | null): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
};

const GUARDED_SETTERS = [
  "setPermissionCheckHandler",
  "setPermissionRequestHandler",
  "setDisplayMediaRequestHandler",
  "setDevicePermissionHandler",
] as const;
const CHOOSER_EVENTS: ReadonlyArray<readonly [string, DeviceChooserKind]> = [
  ["select-hid-device", "hid"],
  ["select-serial-port", "serial"],
  ["select-usb-device", "usb"],
];
const claimed = new WeakSet<object>();
let current: DefaultSessionPermissions | null = null;

/** The dispatcher `main/index.ts` claimed for the default session, once it has. */
export function defaultSessionPermissions(): DefaultSessionPermissions | null {
  return current;
}

function denies(run: () => boolean | undefined): boolean {
  try {
    return run() === true;
  } catch {
    return true;
  }
}

export function claimDefaultSessionPermissions(
  target: PermissionTarget,
  options: { guardSetters?: boolean } = {},
): DefaultSessionPermissions {
  if (claimed.has(target)) {
    throw new Error("The default session's permissions are already owned by default-session-permissions.ts.");
  }
  claimed.add(target);
  const set = {
    check: target.setPermissionCheckHandler.bind(target),
    request: target.setPermissionRequestHandler.bind(target),
    display: target.setDisplayMediaRequestHandler.bind(target),
    device: target.setDevicePermissionHandler.bind(target),
  };
  if (options.guardSetters) {
    for (const name of GUARDED_SETTERS) {
      Object.defineProperty(target, name, {
        configurable: true,
        writable: true,
        value: () => {
          throw new Error("Use default-session-permissions.ts to change the default session's permission handlers.");
        },
      });
    }
  }

  const owner: {
    name: string | null;
    check: CheckHandler | null;
    request: RequestHandler | null;
    display: DisplayHandler | null;
    displayOptions: Electron.DisplayMediaRequestHandlerOpts | undefined;
  } = { name: null, check: null, request: null, display: null, displayOptions: undefined };
  const layers = new Map<string, PermissionDenyLayer>();
  let slot: DisplayMediaGuardSession | null = null;

  const composedCheck: CheckHandler = (webContents, permission, origin, details) => {
    for (const layer of layers.values()) {
      if (layer.denyCheck && denies(() => layer.denyCheck!(webContents, permission, origin, details))) return false;
    }
    return owner.check ? owner.check(webContents, permission, origin, details) : true;
  };
  const composedRequest: RequestHandler = (webContents, permission, callback, details) => {
    for (const layer of layers.values()) {
      if (layer.denyRequest && denies(() => layer.denyRequest!(webContents, permission, details))) {
        callback(false);
        return;
      }
    }
    if (owner.request) owner.request(webContents, permission, callback, details);
    else callback(true);
  };
  const composedDisplay: DisplayHandler = (request, callback) => {
    for (const layer of layers.values()) {
      if (layer.denyDisplay && denies(() => layer.denyDisplay!(request))) {
        callback({});
        return;
      }
    }
    if (owner.display) owner.display(request, callback);
    else callback({});
  };
  const composedDevice: DeviceHandler = (details) => {
    for (const layer of layers.values()) {
      if (layer.denyDevice && denies(() => layer.denyDevice!(details))) return false;
    }
    return false;
  };

  const apply = () => {
    if (layers.size === 0) {
      set.check(owner.check);
      set.request(owner.request);
      if (owner.display) set.display(owner.display, owner.displayOptions);
      else set.display(null);
      set.device(null);
      return;
    }
    set.check(composedCheck);
    set.request(composedRequest);
    set.display(composedDisplay, owner.displayOptions);
    set.device(composedDevice);
  };

  const ownerSlot = (name: string): DisplayMediaGuardSession => {
    if (owner.name !== null && owner.name !== name) {
      throw new Error(`The default session's permission owner slot belongs to "${owner.name}".`);
    }
    owner.name = name;
    slot ??= {
      setPermissionCheckHandler(handler) {
        owner.check = handler;
        if (layers.size === 0) set.check(handler);
      },
      setPermissionRequestHandler(handler) {
        owner.request = handler;
        if (layers.size === 0) set.request(handler);
      },
      setDisplayMediaRequestHandler(handler, displayOptions) {
        owner.display = handler;
        owner.displayOptions = handler ? displayOptions : undefined;
        if (layers.size === 0) {
          if (handler) set.display(handler, displayOptions);
          else set.display(null);
        } else {
          set.display(composedDisplay, owner.displayOptions);
        }
      },
    };
    return slot;
  };

  type Listener = (...args: any[]) => void;
  function eventSubscribers<H>(events: ReadonlyArray<readonly [string, unknown]>, listenerFor: (list: Array<{ name: string; handler: H }>, extra: unknown) => Listener) {
    const list: Array<{ name: string; handler: H }> = [];
    const listeners = events.map(([event, extra]) => [event, listenerFor(list, extra)] as const);
    return (name: string, handler: H) => {
      if (list.some((entry) => entry.name === name)) throw new Error(`A default-session subscriber named "${name}" already exists.`);
      const entry = { name, handler };
      list.push(entry);
      if (list.length === 1) for (const [event, listener] of listeners) target.on(event, listener);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        list.splice(list.indexOf(entry), 1);
        if (list.length === 0) for (const [event, listener] of listeners) target.removeListener(event, listener);
      };
    };
  }

  const onWillDownload = eventSubscribers<WillDownloadHandler>([["will-download", null]], (list) =>
    ((event: Electron.Event, item: Electron.DownloadItem, webContents: Electron.WebContents, frame?: Electron.WebFrameMain | null) => {
      for (const { handler } of list.slice()) {
        let verdict: "cancel" | undefined;
        try {
          verdict = handler(item, webContents, frame ?? null);
        } catch {
          verdict = "cancel";
        }
        if (verdict === "cancel") {
          event.preventDefault();
          item.cancel();
          return;
        }
      }
    }) as Listener,
  );
  const chooseFor = (
    list: ReadonlyArray<{ handler: SelectDeviceHandler }>,
    kind: DeviceChooserKind,
    event: Electron.Event,
    details: Parameters<SelectDeviceHandler>[1],
    callback: (id: string) => void,
  ) => {
    for (const { handler } of list.slice()) {
      let verdict: "cancel" | undefined;
      try {
        verdict = handler(kind, details);
      } catch {
        verdict = "cancel";
      }
      if (verdict === "cancel") {
        event.preventDefault();
        callback("");
        return;
      }
    }
  };
  // Electron 43: HID and USB are (event, details, callback); serial is
  // (event, portList, webContents, callback), with no frame.
  const onSelectDevice = eventSubscribers<SelectDeviceHandler>(CHOOSER_EVENTS, (list, kind) =>
    (kind === "serial"
      ? (event: Electron.Event, _ports: unknown, webContents: Electron.WebContents, callback: (id: string) => void) =>
          chooseFor(list, "serial", event, { frame: null, webContents }, callback)
      : (event: Electron.Event, details: { frame?: Electron.WebFrameMain | null }, callback: (id: string) => void) =>
          chooseFor(list, kind as DeviceChooserKind, event, { frame: details?.frame ?? null }, callback)) as Listener,
  );

  const dispatcher: DefaultSessionPermissions = {
    ownerSlot,
    addDenyLayer(name, layer) {
      if (layers.has(name)) throw new Error(`A default-session deny layer named "${name}" already exists.`);
      layers.set(name, layer);
      apply();
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        layers.delete(name);
        apply();
      };
    },
    onWillDownload,
    onSelectDevice,
  };
  current = dispatcher;
  return dispatcher;
}
