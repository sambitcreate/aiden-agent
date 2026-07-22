import { rendererDocumentOwner, type RendererDocumentOwner } from "./renderer-document-owner.js";

export type ChatGenerationOwner = RendererDocumentOwner;

/** Bind a generation, its stream, cancellation, and approvals to one renderer document. */
export function chatGenerationOwner(event: Electron.IpcMainInvokeEvent): ChatGenerationOwner {
  return rendererDocumentOwner(
    event,
    () => new Error("Chat generation must start from the active application document."),
  );
}
