// Aiden Live's port on the owner's own window, through Electron. The shared
// attachment and DevTools detection live in debugger-port.ts.

import { webContents } from "electron";
import type { RendererDocumentOwner } from "../../renderer-document-owner.js";
import { createSharedDebuggerPort, type DebuggableContents } from "./debugger-port.js";
import type { AidenWindowPort } from "./provider.js";

export function createElectronAidenWindowPort(owner: RendererDocumentOwner): AidenWindowPort | null {
  const contents = webContents.fromId(owner.id);
  if (!contents || contents.isDestroyed()) return null;
  return createSharedDebuggerPort(contents as unknown as DebuggableContents);
}
