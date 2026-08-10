import { formatSkillInvocation } from "@earendil-works/pi-agent-core";
import {
  SLASH_LIMITS,
  SkillInvocationError,
  skillProvenance,
  type SkillProvenanceV1,
} from "../../renderer/shared/slash-commands.js";
import type { RegisteredSkill } from "./skill-registry.js";
import type { Attachment, ChatMessage, ChatRole, ChatStartParams } from "./types.js";
import { chatUserTextWithAttachments } from "./generation-messages.js";
import * as path from "node:path";
import { MAX_CHAT_MESSAGE_CONTENT_BYTES } from "../../renderer/shared/chat-message-contract.js";

const CONFIGURED_SKILL_LOCATION = "/Aiden/Configured Skills/SKILL.md";

export interface PreparedSkillInvocation {
  formattedPrompt: string;
  provenance: SkillProvenanceV1;
  workspaceId: string;
  userMessageId: string;
}

export interface PrepareSkillInvocationForAppendInput {
  invocationId: string;
  role: ChatRole;
  content: string;
  attachments: Attachment[] | undefined;
  workspaceId: string;
  userMessageId: string;
}

export function requireSkillInvocationWorkspace(workspaceId: string | undefined): string {
  if (!workspaceId) {
    throw new SkillInvocationError(
      "workspace_changed",
      "This chat does not have a valid workspace for skill invocation.",
    );
  }
  return workspaceId;
}

export async function prepareSkillInvocationForAppend(
  input: PrepareSkillInvocationForAppendInput,
  resolveFresh: (workspaceId: string, invocationId: string) => Promise<RegisteredSkill>,
): Promise<PreparedSkillInvocation> {
  if (input.role !== "user") {
    throw new SkillInvocationError("invalid_reference", "Only user messages can invoke a skill.");
  }
  if (Buffer.byteLength(input.content, "utf8") > MAX_CHAT_MESSAGE_CONTENT_BYTES) {
    throw new SkillInvocationError(
      "instructions_too_large",
      "The selected skill and message exceed Aiden’s invocation limit.",
    );
  }
  if (!input.content.trim() && !input.attachments?.length) {
    throw new SkillInvocationError(
      "invalid_reference",
      "Add a message or attachment before invoking a skill.",
    );
  }
  const skill = await resolveFresh(input.workspaceId, input.invocationId);
  return formatPreparedSkillInvocation(
    skill,
    chatUserTextWithAttachments(
      input.content,
      input.attachments,
      SLASH_LIMITS.formattedInvocationBytes,
    ),
    input.workspaceId,
    input.userMessageId,
  );
}

export async function commitSkillInvocationForAppend<T>(
  input: PrepareSkillInvocationForAppendInput,
  dependencies: {
    resolveFresh: (workspaceId: string, invocationId: string) => Promise<RegisteredSkill>;
    isCurrent: () => boolean;
    prepareLease: (prepared: PreparedSkillInvocation) => void;
    append: (prepared: PreparedSkillInvocation) => Promise<T>;
  },
): Promise<T> {
  const prepared = await prepareSkillInvocationForAppend(input, dependencies.resolveFresh);
  if (!dependencies.isCurrent()) {
    throw new SkillInvocationError(
      "turn_unavailable",
      "This message turn expired before it could be saved.",
    );
  }
  dependencies.prepareLease(prepared);
  return dependencies.append(prepared);
}

export function preparedSkillPromptForCurrentTurn(
  prepared: PreparedSkillInvocation,
  workspaceId: string,
  currentUser: Pick<ChatMessage, "id" | "skill"> | undefined,
  mode: ChatStartParams["mode"],
): string {
  if (mode !== undefined) {
    throw new Error("Explicit skill invocation is unavailable in Aiden Assistant.");
  }
  if (
    prepared.workspaceId !== workspaceId ||
    currentUser?.id !== prepared.userMessageId ||
    currentUser.skill?.name !== prepared.provenance.name ||
    currentUser.skill.source !== prepared.provenance.source
  ) {
    throw new Error("This skill turn expired before generation could start.");
  }
  return prepared.formattedPrompt;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

export function formatPreparedSkillInvocation(
  skill: RegisteredSkill,
  additionalInstructions: string,
  workspaceId: string,
  userMessageId: string,
): PreparedSkillInvocation {
  const unsafePathCharacter = skill.path
    ? Array.from(skill.path).some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 31 || code === 127;
      })
    : false;
  if (skill.path && (!path.isAbsolute(skill.path) || unsafePathCharacter)) {
    throw new SkillInvocationError(
      "invalid_reference",
      "The selected skill has an unsafe file location.",
    );
  }
  if (Buffer.byteLength(skill.instructions, "utf8") > SLASH_LIMITS.instructionBytes) {
    throw new SkillInvocationError(
      "instructions_too_large",
      "The selected skill and message exceed Aiden’s invocation limit.",
    );
  }
  const piSkill = {
    name: escapeXmlAttribute(skill.name),
    description: skill.description,
    content: skill.instructions,
    filePath: escapeXmlAttribute(skill.path ?? CONFIGURED_SKILL_LOCATION),
  };
  // Ask Pi for the bounded skill-only block first, then account for its exact
  // separator overhead before ever concatenating renderer-controlled message
  // text into a second potentially large string.
  const skillBlock = formatSkillInvocation(piSkill, "");
  const skillBlockBytes = Buffer.byteLength(skillBlock, "utf8");
  const additionalBytes = Buffer.byteLength(additionalInstructions, "utf8");
  const separatorBytes = additionalInstructions ? Buffer.byteLength("\n\n", "utf8") : 0;
  if (
    skillBlockBytes > SLASH_LIMITS.formattedInvocationBytes ||
    additionalBytes > SLASH_LIMITS.formattedInvocationBytes - skillBlockBytes - separatorBytes
  ) {
    throw new SkillInvocationError(
      "instructions_too_large",
      "The selected skill and message exceed Aiden’s invocation limit.",
    );
  }
  const formattedPrompt = additionalInstructions
    ? formatSkillInvocation(piSkill, additionalInstructions)
    : skillBlock;
  return Object.freeze({
    formattedPrompt,
    provenance: Object.freeze(skillProvenance(skill.name, skill.source)),
    workspaceId,
    userMessageId,
  });
}
