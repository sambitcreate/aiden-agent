import { BrowserWindow, dialog } from "../platform.js";
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

export async function unresolvedGuiArtifactMessage(chatId: string): Promise<string | undefined> {
  const image = displayImageArtifactStore.availability();
  const html = generativeUiArtifactStore.availability();
  if (!image.available) {
    return `${image.reason} Open Aiden's developer log to locate the staging file that needs repair.`;
  }
  if (!html.available) {
    return `${html.reason} Open Aiden's developer log to locate the staging file that needs repair.`;
  }
  const { chatStore } = await import("./chat-store.js");
  const chat = await chatStore.get(chatId);
  if (chat) {
    await generativeUiArtifactStore.reconcilePersisted(chat);
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
}): Promise<{ title: string; src: string } | undefined> {
  if (!isHtmlArtifactMediaId(input.mediaId)) return undefined;
  const html = await generativeUiArtifactStore.htmlFor(input.chatId, input.mediaId);
  const artifact = await generativeUiArtifactStore.artifactFor(input.chatId, input.mediaId);
  if (html === undefined || !artifact) return undefined;
  const srcdoc = wrapGenerativeUiHtml(html, artifact.title, parseGenerativeUiTheme(input.theme));
  return {
    title: artifact.title,
    src: registerGenerativeUiPreviewDocument(srcdoc),
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
  const artifact = await generativeUiArtifactStore.artifactFor(input.chatId, input.mediaId);
  const html = await generativeUiArtifactStore.htmlFor(input.chatId, input.mediaId);
  if (!artifact || html === undefined) throw new Error("That artifact is no longer available.");
  const libraries = await loadGenerativeUiHostLibraries();
  const document = generativeUiExportDocument(html, artifact.title, libraries);
  const result = await dialog.showSaveDialog(input.parent, {
    title: "Export artifact",
    defaultPath: `${artifact.title.replace(/[^\w.-]+/gu, "-") || "artifact"}.html`,
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
  const { writeFile } = await import("node:fs/promises");
  await writeFile(result.filePath, document, { encoding: "utf8", mode: 0o600 });
  return { saved: true, canceled: false };
}
