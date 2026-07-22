import { ProviderAuthRequestError, type ProviderAuthOwner } from "./provider-auth-flow-core.js";
import { rendererDocumentOwner } from "./renderer-document-owner.js";

/** Bind an interactive flow to the exact renderer document that invoked it. */
export function providerAuthOwner(event: Electron.IpcMainInvokeEvent): ProviderAuthOwner {
  return rendererDocumentOwner(
    event,
    () =>
      new ProviderAuthRequestError(
        "Provider authentication must start from the active application document.",
      ),
  );
}
