import { createOwnedGoogleGenAIConnector } from "./owned-sdk-connector.js";
import { piCredentialStore } from "../pi-credential-store.js";
import { GeminiLiveService } from "./service.js";
import { experimentalGeminiLiveModel } from "./feature-flag.js";
import { configStore } from "../config-store.js";
import { computerUseStatus } from "../computer-use/status.js";
import { createComputerUseController } from "../computer-use/runtime.js";
import { ComputerUseParameters } from "../computer-use/schema.js";
import { COMPUTER_USE_TOOL_NAME } from "../computer-use/tool.js";
import { ToolApprovalCoordinator } from "../tool-approval.js";
import { GeminiLiveComputerUseBridge } from "./computer-use-bridge.js";
import { app } from "../../platform.js";
import { createGeminiLiveAcceptanceEvidenceRecorder } from "./acceptance-evidence.js";
import { AidenLiveThreadStore } from "../aiden-live-thread-store.js";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";

const aidenLiveThreadStore = new AidenLiveThreadStore(() =>
  path.join(app.getPath("userData"), "aiden-live"),
);
let aidenLiveThreadRecovery: Promise<void> | null = null;
function ensureAidenLiveThreadRecovery(): Promise<void> {
  aidenLiveThreadRecovery ??= aidenLiveThreadStore
    .reconcileActive()
    .then(() => undefined)
    .catch((error: unknown) => {
      aidenLiveThreadRecovery = null;
      process.stderr.write(
        `[aiden-live] stage=thread-recovery result=failed type=${error instanceof Error ? error.name : "unknown"}\n`,
      );
      throw error;
    });
  return aidenLiveThreadRecovery;
}
const computerUseAuthorizations = new Map<
  string,
  { token: string; dispose: () => void }
>();

function ownerKey(owner: RendererDocumentOwner): string {
  return `${owner.id}:${owner.documentId}`;
}

export async function authorizeAidenLiveComputerUse(
  owner: RendererDocumentOwner,
): Promise<string | null> {
  if (owner.isDestroyed()) return null;
  const settings = await configStore.getSettings();
  if (settings.computerUseEnabled !== true) return null;
  const status = await computerUseStatus.status();
  if (!status.ready || owner.isDestroyed()) return null;
  const token = randomUUID();
  const key = ownerKey(owner);
  computerUseAuthorizations.get(key)?.dispose();
  let dispose: () => void = () => undefined;
  dispose = owner.onInvalidated(() => {
    if (computerUseAuthorizations.get(key)?.token === token) computerUseAuthorizations.delete(key);
    dispose();
  });
  computerUseAuthorizations.set(key, { token, dispose });
  return token;
}

const LIVE_COMPUTER_USE_DESCRIPTION =
  "Use Aiden's approval-gated Computer Use controller. Capture an exact window first. You may operate Aiden itself to focus its main composer, choose the current web model or Actions menu, send a prompt, and create or review scheduled tasks. Every click, key, type, drag, scroll, focus, or other mutation pauses for a fresh user Allow once decision.";

/**
 * The default-on beta resolves only the recorded `gemini-3.8-live` model; it
 * never guesses from a normal Gemini chat model or the SDK guide's preview
 * string. `AIDEN_EXPERIMENTAL_GEMINI_LIVE=0` is the emergency rollback.
 */
export const geminiLiveService = new GeminiLiveService({
  credentials: piCredentialStore,
  acceptanceEvidence: createGeminiLiveAcceptanceEvidenceRecorder(
    process.env,
    app.getPath("userData"),
  ),
  threads: {
    begin: async (input) => {
      await ensureAidenLiveThreadRecovery();
      await aidenLiveThreadStore.begin(input);
    },
    finish: async (id, outcome) => {
      await ensureAidenLiveThreadRecovery();
      await aidenLiveThreadStore.finish(id, outcome);
    },
  },
  resolveModel: () => experimentalGeminiLiveModel(),
  createConnector: (apiKey) => createOwnedGoogleGenAIConnector({ apiKey }),
  prepareComputerUse: async ({ authorization, owner, sessionId, signal }) => {
    if (!authorization || signal.aborted || owner.isDestroyed()) return null;
    const key = ownerKey(owner);
    const authorized = computerUseAuthorizations.get(key);
    if (authorized?.token !== authorization) return null;
    computerUseAuthorizations.delete(key);
    authorized.dispose();
    const settings = await configStore.getSettings();
    if (
      signal.aborted ||
      owner.isDestroyed() ||
      settings.computerUseEnabled !== true
    ) {
      return null;
    }
    const status = await computerUseStatus.status({ signal });
    if (!status.ready || signal.aborted || owner.isDestroyed()) return null;
    const confirmedSettings = await configStore.getSettings();
    if (
      signal.aborted ||
      owner.isDestroyed() ||
      confirmedSettings.computerUseEnabled !== true
    ) {
      return null;
    }

    const controller = createComputerUseController(`live:${sessionId}`, true);
    const approvals = new ToolApprovalCoordinator(
      (prompt) => owner.send("chat:approval", prompt),
      (approvalId) => owner.send("chat:approval-withdrawn", { approvalId }),
    );
    // The bridge cannot receive a provider call before setup completes, while
    // bindSendResult runs synchronously before protocol.start().
    let sendToolResult:
      | ((result: { id: string; name: string; response: Record<string, unknown> }) => void)
      | null = null;
    const isAuthorized = async () => {
      const currentSettings = await configStore.getSettings();
      return (
        !signal.aborted &&
        !owner.isDestroyed() &&
        currentSettings.computerUseEnabled === true
      );
    };
    const bridge = new GeminiLiveComputerUseBridge({
      sessionId,
      controller,
      isAuthorized,
      requestApproval: async ({ streamId, toolCallId, toolName, summary, signal: callSignal }) =>
        (await approvals.request(
          { streamId, toolCallId, toolName, summary },
          callSignal,
          owner.documentId,
        )) === "allowed",
      onActivity: (active) =>
        owner.send("assistant-live:event", {
          type: "computer_use_state",
          sessionId,
          active,
        }),
      sendResult: (result) => sendToolResult?.(result),
    });
    return {
      bridge,
      tools: [
        {
          functionDeclarations: [
            {
              name: COMPUTER_USE_TOOL_NAME,
              description: LIVE_COMPUTER_USE_DESCRIPTION,
              parametersJsonSchema: ComputerUseParameters,
            },
          ],
        },
      ],
      approve: (approvalId, allowed, ownerDocumentId) =>
        approvals.decide(approvalId, allowed, ownerDocumentId),
      bindSendResult: (send) => {
        sendToolResult = send;
      },
    };
  },
});
