// The main window's `console-message` listener (moved out of `main/index.ts`
// in design mode v2 Phase 3a, D10, S61).
//
// - Gemini Live's fixed `[aiden-live]` lifecycle markers are forwarded to
//   diagnostics only when the main frame logged them, at most 200 per window,
//   so a subframe can neither forge Live diagnostics nor use up the budget.
//   Nothing else from the console is forwarded.
// - With live apps on, Chromium's notice for a dialog a sandboxed app frame
//   tried to open is counted, one `dialog-suppressed` event per kind per 5 s
//   per frame. The page can print the same text, so the count is display-only
//   and drives no decision.

import type { AppFrameDialogKind } from "../../renderer/shared/design-canvas/app-frame-events.js";
import type { AppFrameRegistry } from "../services/design-canvas/app-frames/app-frame-registry.js";
import { appFrameRef, mainFrameIdOf, type FrameLike } from "../services/design-canvas/app-frames/app-frame-ref.js";

const LIVE_MARKER =
  /^\[aiden-live\] (microphone-ready|input-first-packet|output-first-packet|playback-started|playback-failed|cue-connected|cue-disconnected|cue-failed)$/u;
const LIVE_BUDGET = 200;
const DIALOG_EVERY_MS = 5_000;
// "Ignored call to 'alert()'. The document is sandboxed, and the 'allow-modals' keyword is not set."
const SANDBOXED_DIALOG = /^Ignored call to '(alert|confirm|prompt|print)\(\)'\. The document is sandboxed/u;
const SANDBOXED_UNLOAD = /^Blocked (?:attempt to show a 'beforeunload' confirmation panel|.*beforeunload.*) .*sandboxed/u;

export type ConsoleContents = {
  readonly mainFrame: { readonly frameTreeNodeId: number };
  on(event: "console-message", listener: (details: { message: string; frame?: FrameLike | null }) => void): unknown;
  removeListener(event: "console-message", listener: (details: { message: string; frame?: FrameLike | null }) => void): unknown;
};

export type MainWindowConsoleDeps = {
  liveMarker(message: string): void;
  designLive: boolean;
  registry(): AppFrameRegistry | null;
  now?: () => number;
};

function dialogKind(message: string): AppFrameDialogKind | null {
  const match = SANDBOXED_DIALOG.exec(message);
  if (match) return match[1] as AppFrameDialogKind;
  return SANDBOXED_UNLOAD.test(message) ? "beforeunload" : null;
}

export function installMainWindowConsole(contents: ConsoleContents, deps: MainWindowConsoleDeps): () => void {
  const now = deps.now ?? Date.now;
  let liveCount = 0;
  const lastDialog = new Map<string, number>();
  const listener = (details: { message: string; frame?: FrameLike | null }) => {
    const message = typeof details.message === "string" ? details.message : "";
    const mainId = mainFrameIdOf(contents);
    let isMain = false;
    try {
      isMain = details.frame != null && mainId !== null && details.frame.frameTreeNodeId === mainId;
    } catch {
      isMain = false;
    }
    if (isMain) {
      if (liveCount >= LIVE_BUDGET || !LIVE_MARKER.test(message)) return;
      liveCount += 1;
      deps.liveMarker(message);
      return;
    }
    if (!deps.designLive || !details.frame) return;
    const kind = dialogKind(message);
    if (!kind) return;
    const registry = deps.registry();
    if (!registry || registry.mainContents() !== contents) return;
    const id = registry.registeredAncestor(appFrameRef(details.frame, mainId));
    if (id === null) return;
    const key = `${id}:${kind}`;
    const at = now();
    const last = lastDialog.get(key);
    if (last !== undefined && at - last < DIALOG_EVERY_MS) return;
    lastDialog.set(key, at);
    registry.emitFor(id, { kind: "dialog-suppressed", dialog: kind });
  };
  contents.on("console-message", listener);
  return () => contents.removeListener("console-message", listener);
}
