import { BrowserWindow, dialog } from "../platform.js";
import { randomUUID } from "node:crypto";
import { displayImageArtifactStore } from "./display-image-artifact-store.js";
import { generativeUiArtifactStore } from "./generative-ui-artifact-store.js";
import {
  generativeUiExportDocument,
  parseGenerativeUiTheme,
  wrapGenerativeUiHtml,
} from "./generative-ui-html.js";
import { loadGenerativeUiHostLibraries } from "./generative-ui-host-libraries.js";
import { registerGenerativeUiPreviewDocument } from "./generative-ui-protocol.js";
import { isHtmlArtifactMediaId } from "../../renderer/shared/generative-ui.js";
import {
  DESIGN_ARTIFACT_MEDIA_ID_PREFIX,
  isDesignHtmlArtifact,
} from "../../renderer/shared/design-workspace.js";
import { designGeneratedRevisionService } from "./design-generated-revision-service-main.js";
import { isValidDesignArtifactSource } from "./design-project-health.js";
import { designProjectStore } from "./design-project-store-main.js";
import { projectOwnsPublishedDesignSource } from "./design-generation-context.js";
import { isUsableLiveDesignCandidateSource } from "./design-artifact-source-authority.js";

async function storedHtmlSource(chatId: string, mediaId: string) {
  if (mediaId.startsWith(DESIGN_ARTIFACT_MEDIA_ID_PREFIX)) {
    const source = await generativeUiArtifactStore.committedRecoverySourceFor(chatId, mediaId);
    if (!source) return undefined;
    const project = await designProjectStore.getByChatId(chatId);
    if (
      !isDesignHtmlArtifact(source.artifact) ||
      !isValidDesignArtifactSource(source) ||
      !projectOwnsPublishedDesignSource(project, source)
    ) {
      throw new Error("That Design revision is damaged. Repair it before viewing or exporting.");
    }
    return source;
  }
  const html = await generativeUiArtifactStore.htmlFor(chatId, mediaId);
  const artifact = await generativeUiArtifactStore.artifactFor(chatId, mediaId);
  return html === undefined || !artifact ? undefined : { artifact, html };
}

async function liveDesignCandidateSource(
  chatId: string,
  mediaId: string,
  generationId: string,
) {
  if (!mediaId.startsWith(DESIGN_ARTIFACT_MEDIA_ID_PREFIX)) return undefined;
  const source = await generativeUiArtifactStore.liveDesignCandidateSourceFor({
    chatId,
    mediaId,
    generationId,
  });
  if (!source) return undefined;
  const project = await designProjectStore.getByChatId(chatId);
  if (!isDesignHtmlArtifact(source.artifact) || !isUsableLiveDesignCandidateSource(project, source)) {
    throw new Error("That live Design revision is damaged and cannot be previewed.");
  }
  return source;
}

export async function unresolvedGuiArtifactMessage(chatId: string): Promise<string | undefined> {
  const image = displayImageArtifactStore.availability();
  const html = generativeUiArtifactStore.availability();
  if (!image.available) {
    return `${image.reason} Open Settings → About → Diagnostics and choose Reveal to locate the staging file that needs repair.`;
  }
  if (!html.available) {
    return `${html.reason} Open Settings → About → Diagnostics and choose Reveal to locate the staging file that needs repair.`;
  }
  const { chatStore } = await import("./chat-store.js");
  const chat = await chatStore.get(chatId);
  if (chat) {
    await generativeUiArtifactStore.reconcilePersisted(chat);
    await designGeneratedRevisionService.reconcilePersistedChat(chat);
  }
  if (
    (await displayImageArtifactStore.hasPending(chatId)) ||
    (await generativeUiArtifactStore.hasPending(chatId))
  ) {
    return "A previous visual artifact could not be recovered. Delete this chat to discard it before continuing.";
  }
  return undefined;
}

export async function wrapStoredHtmlArtifact(input: {
  chatId: string;
  mediaId: string;
  theme?: unknown;
  designStudio?: boolean;
  /** Main-authorized active generation; never accepted by export or persisted reads. */
  liveDesignCandidateGenerationId?: string;
}): Promise<{ title: string; src: string; designCapability?: string } | undefined> {
  if (!isHtmlArtifactMediaId(input.mediaId)) return undefined;
  const liveSource = input.designStudio === true && input.liveDesignCandidateGenerationId
    ? await liveDesignCandidateSource(
        input.chatId,
        input.mediaId,
        input.liveDesignCandidateGenerationId,
      )
    : undefined;
  const source = liveSource ?? (await storedHtmlSource(input.chatId, input.mediaId));
  if (!source) return undefined;
  const { artifact, html } = source;
  const designCapability =
    input.designStudio === true && isDesignHtmlArtifact(artifact) ? randomUUID() : undefined;
  const srcdoc = wrapGenerativeUiHtml(
    html,
    artifact.title,
    parseGenerativeUiTheme(input.theme),
    designCapability ? { designCapability } : undefined,
  );
  return {
    title: artifact.title,
    src: registerGenerativeUiPreviewDocument(srcdoc, {
      designStudio: designCapability !== undefined,
    }),
    ...(designCapability ? { designCapability } : {}),
  };
}

export async function exportStoredHtmlArtifact(input: {
  chatId: string;
  mediaId: string;
  parent: InstanceType<typeof BrowserWindow>;
}): Promise<{ saved: boolean; canceled: boolean }> {
  const unresolved = await unresolvedGuiArtifactMessage(input.chatId);
  if (unresolved) {
    throw new Error(
      unresolved.includes("could not be recovered")
        ? "A previous visual artifact could not be recovered. Delete this chat to discard it before exporting."
        : unresolved,
    );
  }
  if (!input.parent || input.parent.isDestroyed()) {
    throw new Error("The export window is unavailable.");
  }
  const source = await storedHtmlSource(input.chatId, input.mediaId);
  if (!source) throw new Error("That artifact is no longer available.");
  const result = await dialog.showSaveDialog(input.parent, {
    title: "Export artifact",
    defaultPath: `${source.artifact.title.replace(/[^\w.-]+/gu, "-") || "artifact"}.html`,
    filters: [{ name: "HTML", extensions: ["html"] }],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });
  if (result.canceled || !result.filePath) return { saved: false, canceled: true };
  const unresolvedAfterDialog = await unresolvedGuiArtifactMessage(input.chatId);
  if (unresolvedAfterDialog) {
    throw new Error(
      unresolvedAfterDialog.includes("could not be recovered")
        ? "A previous visual artifact could not be recovered. Delete this chat to discard it before exporting."
        : unresolvedAfterDialog,
    );
  }
  const finalSource = await storedHtmlSource(input.chatId, input.mediaId);
  if (!finalSource) throw new Error("That artifact is no longer available.");
  const libraries = await loadGenerativeUiHostLibraries();
  const document = generativeUiExportDocument(
    finalSource.html,
    finalSource.artifact.title,
    libraries,
  );
  const { writeFile } = await import("node:fs/promises");
  await writeFile(result.filePath, document, { encoding: "utf8", mode: 0o600 });
  return { saved: true, canceled: false };
}
