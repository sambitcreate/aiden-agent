import { dialog } from "../platform.js";
import { displayImageArtifactStore } from "./display-image-artifact-store.js";
import { generativeUiArtifactStore } from "./generative-ui-artifact-store.js";
import {
  generativeUiExportDocument,
  parseGenerativeUiTheme,
  wrapGenerativeUiHtml,
} from "./generative-ui-html.js";
import { loadGenerativeUiHostLibraries } from "./generative-ui-host-libraries.js";
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
}): Promise<{ title: string; srcdoc: string } | undefined> {
  if (!isHtmlArtifactMediaId(input.mediaId)) return undefined;
  const html = await generativeUiArtifactStore.htmlFor(input.chatId, input.mediaId);
  const artifact = await generativeUiArtifactStore.artifactFor(input.chatId, input.mediaId);
  if (html === undefined || !artifact) return undefined;
  return {
    title: artifact.title,
    srcdoc: wrapGenerativeUiHtml(html, artifact.title, parseGenerativeUiTheme(input.theme)),
  };
}

export async function exportStoredHtmlArtifact(input: {
  chatId: string;
  mediaId: string;
}): Promise<{ saved: boolean; canceled: boolean }> {
  const artifact = await generativeUiArtifactStore.artifactFor(input.chatId, input.mediaId);
  const html = await generativeUiArtifactStore.htmlFor(input.chatId, input.mediaId);
  if (!artifact || html === undefined) throw new Error("That artifact is no longer available.");
  const libraries = await loadGenerativeUiHostLibraries();
  const document = generativeUiExportDocument(html, artifact.title, libraries);
  const result = await dialog.showSaveDialog({
    title: "Export artifact",
    defaultPath: `${artifact.title.replace(/[^\w.-]+/gu, "-") || "artifact"}.html`,
    filters: [{ name: "HTML", extensions: ["html"] }],
  });
  if (result.canceled || !result.filePath) return { saved: false, canceled: true };
  const { writeFile } = await import("node:fs/promises");
  await writeFile(result.filePath, document, { encoding: "utf8", mode: 0o600 });
  return { saved: true, canceled: false };
}
