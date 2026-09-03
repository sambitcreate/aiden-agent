import {
  sameChatHtmlArtifactDescriptor,
  type ChatHtmlArtifactV1,
} from "../../renderer/shared/chat-artifacts.js";
import { isDesignHtmlArtifact } from "../../renderer/shared/design-workspace.js";
import type { DesignProjectSnapshot as DesignProjectSnapshotV1 } from "./design-project-contract.js";
import {
  isValidDesignArtifactSource,
  projectOwnsPublishedDesignSource,
} from "./design-artifact-source-authority.js";
import type { CommittedGenerativeUiRecoverySource } from "./generative-ui-artifact-store.js";

export {
  isUsablePublishedDesignSource,
  projectOwnsPublishedDesignSource,
} from "./design-artifact-source-authority.js";

export interface DesignContextChatV1 {
  messages: readonly {
    role: string;
    htmlArtifacts?: readonly ChatHtmlArtifactV1[];
  }[];
}

export function projectOwnsDesignMedia(
  project: DesignProjectSnapshotV1 | undefined,
  mediaId: string,
): boolean {
  return (
    project?.canvas.nodes.some(
      (node) =>
        node.kind === "artboard" &&
        node.lineageId !== undefined &&
        node.artifactMediaIds?.includes(mediaId) === true,
    ) === true
  );
}

/** Select only a currently active, main-owned revision for implicit refinement. */
export function latestActiveDesignArtifact(
  chat: DesignContextChatV1,
  project: DesignProjectSnapshotV1 | undefined,
): ChatHtmlArtifactV1 | undefined {
  const activeMediaIds = new Set(
    project?.canvas.nodes.flatMap((node) =>
      node.kind === "artboard" && node.activeMediaId ? [node.activeMediaId] : [],
    ) ?? [],
  );
  for (let messageIndex = chat.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = chat.messages[messageIndex];
    if (message?.role !== "assistant") continue;
    const artifact = [...(message.htmlArtifacts ?? [])]
      .reverse()
      .find(
        (candidate) => isDesignHtmlArtifact(candidate) && activeMediaIds.has(candidate.mediaId),
      );
    if (artifact) return artifact;
  }
  return undefined;
}

/** Return provider context only after commitment, exact descriptor binding, and semantic validation. */
export function requireCommittedDesignContextHtml(
  expected: ChatHtmlArtifactV1,
  source: CommittedGenerativeUiRecoverySource | undefined,
  project?: DesignProjectSnapshotV1,
): string {
  if (!source) {
    throw new Error(
      "A selected Design canvas item is no longer available. Select it again and retry.",
    );
  }
  if (
    !sameChatHtmlArtifactDescriptor(source.artifact, expected) ||
    !isValidDesignArtifactSource(source) ||
    (project !== undefined
      ? !projectOwnsPublishedDesignSource(project, source)
      : source.designOwnership !== undefined || source.designPublication !== undefined)
  ) {
    throw new Error("A selected Design canvas item is damaged. Repair it before continuing.");
  }
  return source.html;
}
