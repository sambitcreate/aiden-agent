// designProjects:run, previewSrc and readSource (ADR-DS §6, channels 8-10).
// Cancel, approvals and questionnaires reuse the owner-checked chat:* channels.
import type { IpcMainInvokeEvent } from "electron";
import type { DesignRunStartResult } from "../../../renderer/shared/design/types.js";
import type { ChatGenerationOwner } from "../../services/chat-generation-owner.js";
import type { DesignRunStartInput } from "../../services/design/run-service.js";
import { DesignStoreError } from "../../services/design/store-core.js";
import { parseDesignPreviewRequest, parseDesignRevisionRequest, parseDesignRunStartRequest } from "./params.js";
import { settleDesignCallAsync, type DesignIpcFailure } from "./results.js";
import type { DesignIpcRegistrar } from "./projects.js";

export interface DesignRunHandlerDeps {
  runs: { start(input: DesignRunStartInput): Promise<DesignRunStartResult> };
  /** chatGenerationOwner in production; throws for an inactive document. */
  generationOwner(event: IpcMainInvokeEvent): ChatGenerationOwner;
  assertOwner(event: IpcMainInvokeEvent): void;
  preview(input: { projectId: string; revisionId: string; theme?: unknown }): Promise<{ src: string; title: string }>;
  readSource(projectId: string, revisionId: string): Promise<{ html: string; bytes: number }>;
}

export function registerDesignRunHandlers(ipc: DesignIpcRegistrar, deps: DesignRunHandlerDeps): void {
  ipc.handle("designProjects:run", async (event, request: unknown): Promise<DesignRunStartResult> => {
    const owner = deps.generationOwner(event);
    const input = parseDesignRunStartRequest(request);
    try {
      return await deps.runs.start({ ...input, owner });
    } catch (error) {
      // A refused store write (for example a stale Resume) is shown to the user, not thrown.
      if (error instanceof DesignStoreError) return { accepted: false, error: error.message };
      throw error;
    }
  });

  ipc.handle("designProjects:previewSrc", (event, request: unknown): Promise<{ src: string; title: string } | DesignIpcFailure> => {
    deps.assertOwner(event);
    const input = parseDesignPreviewRequest(request);
    return settleDesignCallAsync(() => deps.preview(input));
  });

  ipc.handle("designProjects:readSource", (event, request: unknown): Promise<{ html: string; bytes: number } | DesignIpcFailure> => {
    deps.assertOwner(event);
    const { projectId, revisionId } = parseDesignRevisionRequest(request);
    return settleDesignCallAsync(async () => {
      const { html, bytes } = await deps.readSource(projectId, revisionId);
      return { html, bytes };
    });
  });
}
