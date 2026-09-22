import { parse, type DefaultTreeAdapterTypes } from "parse5";
import type { DesignProjectSnapshot } from "./design-project-contract.js";
import type { DesignGenerationIntentV1 } from "../../renderer/shared/design-generation.js";
import { normalizeDesignLanguageDocument, designLanguageContentHash } from "./design-language-core.js";
import type { DesignSystemSnapshotV1 } from "./design-system-snapshot-core.js";
import { isUsablePublishedDesignSource } from "./design-artifact-source-authority.js";

/** Parse HTML without running scripts or loading assets; retain only static CSS literals. */
export function deriveDesignLanguageFromHtml(html: string) {
  if (Buffer.byteLength(html, "utf8") > 2 * 1024 * 1024) throw new Error("Screen is too large to derive a Design Language.");
  const tokens: Record<"colors" | "spacing" | "typography" | "radii", Record<string, string>> = { colors: {}, spacing: {}, typography: {}, radii: {} };
  const declarations: string[] = [];
  const pending: DefaultTreeAdapterTypes.Node[] = [parse(html)];
  let visited = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if (++visited > 50_000) throw new Error("Screen is too complex to derive a Design Language.");
    if ("tagName" in node) {
      if (node.tagName === "style") declarations.push(node.childNodes.flatMap((child) => "value" in child ? [child.value] : []).join(""));
      for (const attr of node.attrs) if (attr.name === "style") declarations.push(attr.value);
    }
    if ("childNodes" in node) for (let index = node.childNodes.length - 1; index >= 0; index--) pending.push(node.childNodes[index]!);
  }
  for (const css of declarations) {
    const clean = css.replace(/\/\*[\s\S]*?\*\//gu, "");
    for (const match of clean.matchAll(/(?:^|[;{])\s*(--[a-z0-9_-]+|[a-z][a-z-]*)\s*:\s*([^;{}]+)(?=;|\}|$)/giu)) {
      const property = match[1]!.toLowerCase();
      const value = match[2]!.trim();
      const name = property.replace(/^--/u, "").replace(/-/gu, ".");
      let group: keyof typeof tokens | undefined;
      if (/^(?:#[a-f0-9]{3}|#[a-f0-9]{4}|#[a-f0-9]{6}|#[a-f0-9]{8}|(?:rgb|rgba|hsl|hsla|oklab|oklch|lab|lch)\([0-9.+,% /-]{1,120}\)|transparent)$/iu.test(value)) group = "colors";
      else if (/^(?:0|\d+(?:\.\d+)?(?:px|rem|em|%))$/u.test(value)) {
        if (/radius|radii/iu.test(property)) group = "radii";
        else if (/font-size|line-height|letter-spacing|typography/iu.test(property)) group = "typography";
        else if (/padding|margin|gap|space|spacing/iu.test(property)) group = "spacing";
      } else if (/^(?:system-ui|sans-serif|serif|monospace)$/u.test(value) && /font/iu.test(property)) group = "typography";
      if (group && Object.keys(tokens[group]).length < 32) {
        try {
          const checked = normalizeDesignLanguageDocument({ version: 1, name: "Screen language", guidance: "", tokens: { colors: {}, spacing: {}, typography: {}, radii: {}, [group]: { [name]: value } } });
          tokens[group][name] = checked.tokens[group][name]!;
        } catch { /* Unsupported literals and identifiers are excluded from the subset. */ }
      }
    }
  }
  return normalizeDesignLanguageDocument({ version: 1, name: "Screen language", guidance: "Derived static CSS literals. Review these tokens before applying them.", tokens });
}

export async function deriveDesignLanguageFromScreen(project: DesignProjectSnapshot, mediaId: string) {
  const { generativeUiArtifactStore } = await import("./generative-ui-artifact-store.js");
  const source = await generativeUiArtifactStore.committedRecoverySourceFor(project.chatId, mediaId);
  if (!isUsablePublishedDesignSource(project, source)) throw new Error("Select an exact committed Screen revision to derive its language.");
  const node = project.canvas.nodes.find((node) => node.kind === "artboard" && node.artifactMediaIds?.includes(mediaId));
  if (!node?.lineageId) throw new Error("The selected Screen lineage is unavailable.");
  const { createHash } = await import("node:crypto");
  return { document: deriveDesignLanguageFromHtml(source.html), provenance: { kind: "derived" as const, lineageId: node.lineageId, mediaId, contentHash: createHash("sha256").update(source.html).digest("hex") } };
}

export function designLanguageFromWorkspaceSnapshot(snapshot: DesignSystemSnapshotV1) {
  const tokens = { colors: {}, spacing: {}, radii: {}, typography: {} } as ReturnType<typeof normalizeDesignLanguageDocument>["tokens"];
  const groups = ["colors", "spacing", "radii", "typography"] as const;
  for (const group of groups) for (const token of snapshot.tokens[group].slice(0, 32)) {
    const value = "value" in token ? token.value : token.size;
    const name = token.name.replace(/[^a-zA-Z0-9._-]/gu, ".");
    try {
      const checked = normalizeDesignLanguageDocument({ version: 1, name: "Workspace language", guidance: "", tokens: { colors: {}, spacing: {}, radii: {}, typography: {}, [group]: { [name]: value } } });
      tokens[group][name] = checked.tokens[group][name]!;
    } catch { /* Workspace tokens outside the portable subset stay in the attached snapshot. */ }
  }
  return { document: normalizeDesignLanguageDocument({ version: 1, name: "Workspace language", guidance: "Use the supported static tokens from the reviewed workspace snapshot consistently.", tokens }), provenance: { kind: "workspace-snapshot" as const, id: snapshot.id, revision: snapshot.revision, contentHash: snapshot.contentHash } };
}

export async function importWorkspaceDesignLanguage(project: DesignProjectSnapshot, workspaceRoot: string) {
  const { currentDesignSystemSnapshot } = await import("./design-system-attachment-service-main.js");
  const snapshot = await currentDesignSystemSnapshot(project, workspaceRoot);
  if (!snapshot) throw new Error("Attach and review a current workspace design-system snapshot first.");
  return designLanguageFromWorkspaceSnapshot(snapshot);
}

/** Path-free guidance, emitted only after exact language and workspace freshness checks. */
export async function currentDesignLanguageModelContext(project: DesignProjectSnapshot, workspaceRoot?: string, intent?: DesignGenerationIntentV1, dependencies: { currentWorkspaceSnapshot?: (project: DesignProjectSnapshot, root: string) => Promise<DesignSystemSnapshotV1 | undefined> } = {}) {
  if (project.version !== 2) return undefined;
  const binding = project.activeDesignLanguage;
  if (intent && (intent.designLanguage?.id !== binding?.id || intent.designLanguage?.revision !== binding?.revision || intent.designLanguage?.contentHash !== binding?.contentHash)) throw new Error("The active Design Language changed. Review it before generating again.");
  if (!binding) return undefined;
  const language = project.designLanguages?.find((item) => item.id === binding.id && item.revision === binding.revision && item.contentHash === binding.contentHash);
  if (!language || designLanguageContentHash(language.document) !== binding.contentHash) throw new Error("The bound Design Language is unavailable or damaged.");
  if (language.provenance.kind === "workspace-snapshot") {
    if (!workspaceRoot || project.connectionState !== "connected") throw new Error("Reconnect the workspace before using its Design Language.");
    const load = dependencies.currentWorkspaceSnapshot ?? (await import("./design-system-attachment-service-main.js")).currentDesignSystemSnapshot;
    const current = await load(project, workspaceRoot);
    if (!current || current.id !== language.provenance.id || current.revision !== language.provenance.revision || current.contentHash !== language.provenance.contentHash) throw new Error("Refresh the stale workspace Design Language before generating.");
  }
  return language.document;
}
