// Injects the live app bridge into the main window's admitted app frames
// (design mode v2 Phase 3a, D12, S11), with live apps on only.
//
// A frame gets the bridge only if it is itself an admitted app frame (not a
// frame nested inside one) and its current origin is a running app's. It is
// injected at the frame's `dom-ready` and again at `did-frame-finish-load`
// with the same per-document nonce, so the bridge's once-guard installs it
// once; `did-frame-navigate` starts a new document and a new nonce.
//
// `executeJavaScript` runs with `userGesture` false, so injection never grants
// the page user activation, and main never waits on what the page returns.

import { randomUUID } from "node:crypto";

import { appBridgeInjection } from "./app-bridge-source.js";

const MAX_NONCES = 512;

export type AppBridgeFrame = {
  readonly frameTreeNodeId: number;
  readonly origin: string;
  executeJavaScript(code: string, userGesture?: boolean): unknown;
  once?(event: "dom-ready", listener: () => void): unknown;
  isDestroyed?(): boolean;
};

type Contents = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
};

export type AppBridgeDeps = {
  enabled: boolean;
  registry(): { isAppFrame(frameTreeNodeId: number): boolean } | null;
  isAppOrigin(origin: string): boolean;
  /** `webFrameMain.fromId`. */
  fromId(processId: number, routingId: number): AppBridgeFrame | null | undefined;
  nonce?(): string;
};

export function installAppBridge(contents: Contents, deps: AppBridgeDeps): () => void {
  if (!deps.enabled) return () => undefined;
  const makeNonce = deps.nonce ?? randomUUID;
  const nonces = new Map<number, string>();
  const nonceFor = (frameTreeNodeId: number): string => {
    let nonce = nonces.get(frameTreeNodeId);
    if (!nonce) {
      if (nonces.size >= MAX_NONCES) nonces.delete(nonces.keys().next().value as number);
      nonce = makeNonce();
      nonces.set(frameTreeNodeId, nonce);
    }
    return nonce;
  };

  const inject = (frame: AppBridgeFrame | null | undefined): void => {
    try {
      if (!frame || frame.isDestroyed?.()) return;
      const registry = deps.registry();
      if (!registry?.isAppFrame(frame.frameTreeNodeId) || !deps.isAppOrigin(frame.origin)) return;
      const pending = frame.executeJavaScript(appBridgeInjection(nonceFor(frame.frameTreeNodeId)), false);
      // Only Electron's own promise is watched, and only for its rejection.
      if (pending instanceof Promise) pending.catch(() => undefined);
    } catch {
      // The frame went away between the event and the call.
    }
  };

  const onCreated = (_event: unknown, details: { frame?: AppBridgeFrame | null }) => {
    const frame = details?.frame;
    frame?.once?.("dom-ready", () => inject(frame));
  };
  const onFinished = (_event: unknown, isMainFrame: boolean, processId: number, routingId: number) => {
    if (!isMainFrame) inject(deps.fromId(processId, routingId));
  };
  const onNavigated = (_event: unknown, _url: string, _code: number, _status: string, isMainFrame: boolean, processId: number, routingId: number) => {
    if (isMainFrame) return;
    const frame = deps.fromId(processId, routingId);
    if (frame) nonces.delete(frame.frameTreeNodeId);
  };

  contents.on("frame-created", onCreated as never);
  contents.on("did-frame-finish-load", onFinished as never);
  contents.on("did-frame-navigate", onNavigated as never);
  return () => {
    contents.removeListener("frame-created", onCreated as never);
    contents.removeListener("did-frame-finish-load", onFinished as never);
    contents.removeListener("did-frame-navigate", onNavigated as never);
    nonces.clear();
  };
}
