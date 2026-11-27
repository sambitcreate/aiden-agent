import { parseAppControlPanels, type AppControlPanel } from "../../renderer/shared/app-controls.js";
import { parseAgentNoticeV1, type AgentNoticeV1 } from "../../renderer/shared/agent-notices.js";
import {
  parseAssistantTurnStatsV1,
  type AssistantTurnStatsV1,
} from "../../renderer/shared/assistant-turn-stats.js";
import { parseChatUiVisuals } from "../../renderer/shared/aiden-ui/visual.js";
import type { ChatUiVisualV1 } from "../../renderer/shared/aiden-ui/types.js";
import {
  parseGrabbedElements,
  type GrabbedElementContextV1,
} from "../../renderer/shared/browser-element-grab.js";
import {
  parseChatHtmlArtifacts,
  parseChatImagePlacements,
  parseHtmlArtifactPlacements,
  type ChatHtmlArtifactV1,
  type ChatImagePlacementV1,
  type HtmlArtifactPlacementV1,
} from "../../renderer/shared/chat-artifacts.js";
import {
  parseChatInputSource,
  type ChatInputSourceV1,
} from "../../renderer/shared/chat-input-source.js";
import {
  parseGenerationTimeline,
  type GenerationTimeline,
} from "../../renderer/shared/generation-timeline.js";
import {
  parseSkillProvenanceV1,
  type SkillProvenanceV1,
} from "../../renderer/shared/slash-commands.js";
import {
  parseSubagentMessageReferenceV1,
  type SubagentMessageReferenceV1,
} from "../../renderer/shared/subagent-runs.js";
import {
  parseVisualSnapshots,
  type VisualSnapshotRefV1,
} from "../../renderer/shared/visual-snapshots.js";
import { safeStoredAttachments } from "./attachment-contract.js";
import { parseStoredPiAssistantMessage } from "./pi-message-storage.js";
import type { Attachment, ChatMessage } from "./types.js";

export interface StoredMessageFieldsInput {
  role?: unknown;
  attachments?: unknown;
  grabbedElements?: unknown;
  appPanels?: unknown;
  htmlArtifacts?: unknown;
  htmlArtifactPlacements?: unknown;
  imagePlacements?: unknown;
  uiVisuals?: unknown;
  visualSnapshots?: unknown;
  skill?: unknown;
  notice?: unknown;
  inputSource?: unknown;
  fromLeadChat?: unknown;
}

export interface StoredMessageFields {
  attachments: Attachment[] | undefined;
  grabbedElements?: GrabbedElementContextV1[];
  appPanels?: AppControlPanel[] | undefined;
  htmlArtifacts?: ChatHtmlArtifactV1[] | undefined;
  htmlArtifactPlacements?: HtmlArtifactPlacementV1[] | undefined;
  imagePlacements: ChatImagePlacementV1[] | undefined;
  uiVisuals: ChatUiVisualV1[] | undefined;
  visualSnapshots?: VisualSnapshotRefV1[] | undefined;
  skill: SkillProvenanceV1 | undefined;
  notice: AgentNoticeV1 | undefined;
  inputSource: ChatInputSourceV1 | undefined;
  fromLeadChat?: true | undefined;
}

export interface ParseStoredMessageFieldsOptions {
  /** Include `appPanels` (omitted when panels have already been folded into content). */
  includeAppPanels?: boolean;
  /** Include `fromLeadChat` (emitted only by `readChat` and `appendMessage`). */
  includeFromLeadChat?: boolean;
  /** Include `htmlArtifacts`, `htmlArtifactPlacements`, and `visualSnapshots` (remapped by `copyChat`). */
  includeVisualArtifacts?: boolean;
}

export function parseStoredMessageFields(
  message: StoredMessageFieldsInput,
  options: ParseStoredMessageFieldsOptions = {},
): StoredMessageFields {
  const {
    includeAppPanels = true,
    includeFromLeadChat = false,
    includeVisualArtifacts = true,
  } = options;
  const assistant = message.role === "assistant";
  const user = message.role === "user";
  const grabbedElements = user
    ? parseGrabbedElements(message.grabbedElements, "stored")
    : undefined;
  return {
    attachments: safeStoredAttachments(message.attachments),
    ...(grabbedElements ? { grabbedElements } : {}),
    ...(includeAppPanels
      ? { appPanels: assistant ? parseAppControlPanels(message.appPanels) : undefined }
      : {}),
    ...(includeVisualArtifacts
      ? {
          htmlArtifacts: assistant ? parseChatHtmlArtifacts(message.htmlArtifacts) : undefined,
          htmlArtifactPlacements:
            assistant && message.htmlArtifacts
              ? parseHtmlArtifactPlacements(message.htmlArtifactPlacements)
              : undefined,
          visualSnapshots: assistant ? parseVisualSnapshots(message.visualSnapshots) : undefined,
        }
      : {}),
    imagePlacements: assistant ? parseChatImagePlacements(message.imagePlacements) : undefined,
    uiVisuals: assistant ? parseChatUiVisuals(message.uiVisuals) : undefined,
    skill: user ? parseSkillProvenanceV1(message.skill) : undefined,
    notice: user ? parseAgentNoticeV1(message.notice) : undefined,
    inputSource: user ? parseChatInputSource(message.inputSource) : undefined,
    ...(includeFromLeadChat
      ? {
          fromLeadChat:
            user && message.fromLeadChat === true && !message.notice ? true : undefined,
        }
      : {}),
  };
}

export interface StoredAssistantProtocolInput {
  role?: unknown;
  content: string;
  reasoning?: unknown;
  pi?: unknown;
  timeline?: unknown;
  turnStats?: unknown;
  subagents?: unknown;
}

export interface StoredAssistantProtocol {
  reasoning: string | undefined;
  pi: ChatMessage["pi"];
  timeline: GenerationTimeline | undefined;
  turnStats: AssistantTurnStatsV1 | undefined;
  subagents: SubagentMessageReferenceV1 | undefined;
}

export function parseStoredAssistantProtocol(
  message: StoredAssistantProtocolInput,
): StoredAssistantProtocol {
  const assistant = message.role === "assistant";
  return {
    reasoning:
      assistant &&
      typeof message.reasoning === "string" &&
      message.reasoning.trim()
        ? message.reasoning
        : undefined,
    pi: assistant ? parseStoredPiAssistantMessage(message.pi) : undefined,
    timeline: assistant
      ? parseGenerationTimeline(message.timeline, message.content.length)
      : undefined,
    turnStats: assistant ? parseAssistantTurnStatsV1(message.turnStats) : undefined,
    subagents: assistant ? parseSubagentMessageReferenceV1(message.subagents) : undefined,
  };
}
