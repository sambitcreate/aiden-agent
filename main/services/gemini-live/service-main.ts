import { createOwnedGoogleGenAIConnector } from "./owned-sdk-connector.js";
import { piCredentialStore } from "../pi-credential-store.js";
import { GeminiLiveService } from "./service.js";
import { experimentalGeminiLiveModel } from "./feature-flag.js";
import { configStore } from "../config-store.js";
import { chatStore } from "../chat-store.js";
import { computerUseStatus } from "../computer-use/status.js";
import { createComputerUseController } from "../computer-use/runtime.js";
import { ComputerUseParameters } from "../computer-use/schema.js";
import { COMPUTER_USE_TOOL_NAME } from "../computer-use/tool.js";
import { ToolApprovalCoordinator } from "../tool-approval.js";
import { ASSISTANT_WORKSPACE_ID } from "../../../renderer/shared/assistant.js";
import { GeminiLiveComputerUseBridge } from "./computer-use-bridge.js";
import { app } from "../../platform.js";
import { createGeminiLiveAcceptanceEvidenceRecorder } from "./acceptance-evidence.js";

const LIVE_COMPUTER_USE_DESCRIPTION =
  "Use Aiden's approval-gated Computer Use controller. Capture an exact window first. Every click, key, type, drag, scroll, focus, or other mutation pauses for a fresh user Allow once decision.";

/**
 * Production stays fail-closed until an authorized real-model probe records a
 * supported model. Phase 1 proves the boundary only; it does not guess from a
 * normal Gemini chat model or the SDK guide's preview string.
 */
export const geminiLiveService = new GeminiLiveService({
  credentials: piCredentialStore,
  acceptanceEvidence: createGeminiLiveAcceptanceEvidenceRecorder(
    process.env,
    app.getPath("userData"),
  ),
  resolveModel: () => experimentalGeminiLiveModel(),
  createConnector: (apiKey) => createOwnedGoogleGenAIConnector({ apiKey }),
  prepareComputerUse: async ({ chatId, owner, sessionId, signal }) => {
    if (!chatId || signal.aborted || owner.isDestroyed()) return null;
    const [settings, chat] = await Promise.all([
      configStore.getSettings(),
      chatStore.get(chatId),
    ]);
    if (
      signal.aborted ||
      owner.isDestroyed() ||
      settings.computerUseEnabled !== true ||
      chat?.workspaceId !== ASSISTANT_WORKSPACE_ID ||
      chat.computerUseEnabled !== true
    ) {
      return null;
    }
    const status = await computerUseStatus.status({ signal });
    if (!status.ready || signal.aborted || owner.isDestroyed()) return null;
    const [confirmedSettings, confirmedChat] = await Promise.all([
      configStore.getSettings(),
      chatStore.get(chatId),
    ]);
    if (
      signal.aborted ||
      owner.isDestroyed() ||
      confirmedSettings.computerUseEnabled !== true ||
      confirmedChat?.workspaceId !== ASSISTANT_WORKSPACE_ID ||
      confirmedChat.computerUseEnabled !== true
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
    let sendToolResult: ((result: {
      id: string;
      name: string;
      response: Record<string, unknown>;
    }) => void) | null = null;
    const isAuthorized = async () => {
      const [currentSettings, currentChat] = await Promise.all([
        configStore.getSettings(),
        chatStore.get(chatId),
      ]);
      return (
        !signal.aborted &&
        !owner.isDestroyed() &&
        currentSettings.computerUseEnabled === true &&
        currentChat?.workspaceId === ASSISTANT_WORKSPACE_ID &&
        currentChat.computerUseEnabled === true
      );
    };
    const bridge = new GeminiLiveComputerUseBridge({
      sessionId,
      controller,
      isAuthorized,
      requestApproval: ({ streamId, toolCallId, toolName, summary, signal: callSignal }) =>
        approvals.request(
          { streamId, toolCallId, toolName, summary },
          callSignal,
          owner.documentId,
        ),
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
