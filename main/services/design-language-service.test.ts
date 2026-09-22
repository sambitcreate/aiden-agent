import assert from "node:assert/strict";
import test from "node:test";
import { deriveDesignLanguageFromHtml, designLanguageFromWorkspaceSnapshot, currentDesignLanguageModelContext } from "./design-language-service.js";
import { designLanguageContentHash } from "./design-language-core.js";
import type { DesignProjectSnapshotV2 } from "../../renderer/shared/design-projects.js";
import type { DesignSystemSnapshotV1 } from "./design-system-snapshot-core.js";

test("Screen language derivation is deterministic and includes only supported static literals", () => {
  const html = `<script>throw new Error('must not execute');</script><style>:root{--accent:#ABC;--space-small:8px;--radius:4px;--unsafe:url(https://example.test);--constructor:#fff}main{padding:16px;color:var(--accent)}</style><main style="font-size:18px;background:#fff">Page</main>`;
  const first = deriveDesignLanguageFromHtml(html);
  assert.deepEqual(first, deriveDesignLanguageFromHtml(html));
  assert.equal(first.tokens.colors.accent, "#abc");
  assert.equal(first.tokens.spacing["space.small"], "8px");
  assert.equal(first.tokens.radii.radius, "4px");
  assert.equal(first.tokens.typography["font.size"], "18px");
  assert.doesNotMatch(JSON.stringify(first), /example|execute|constructor|var\(/u);
  assert.deepEqual(deriveDesignLanguageFromHtml('<script>"<style>:root{--evil:#123}</style>"</script>').tokens.colors, {});
});

test("language model context rejects changed binding, corrupt hashes, and stale workspace snapshots", async () => {
  const document = deriveDesignLanguageFromHtml('<style>:root{--accent:#123}</style>');
  const binding = { id: "language:one", revision: 1, contentHash: designLanguageContentHash(document) };
  const snapshot = { id: "snapshot:one", revision: 1, contentHash: "a".repeat(64) } as DesignSystemSnapshotV1;
  const project: DesignProjectSnapshotV2 = { version: 2, id: "project:language", revision: 1, title: "Language", titlePolicy: { state: "manual" }, chatId: "chat:language", workspaceId: "workspace:language", createdAt: 1, updatedAt: 1, canvas: { viewport: "desktop", flowViewport: { x: 0, y: 0, zoom: 1 }, nodes: [] }, referenceAssetIds: [], connectionState: "connected", activeDesignLanguage: binding, designLanguages: [{ ...binding, document, provenance: { kind: "workspace-snapshot", ...snapshot }, createdAt: 1 }] };
  const deps = { currentWorkspaceSnapshot: async () => snapshot };
  assert.deepEqual(await currentDesignLanguageModelContext(project, "/workspace", undefined, deps), document);
  await assert.rejects(currentDesignLanguageModelContext(project, "/workspace", undefined, { currentWorkspaceSnapshot: async () => ({ ...snapshot, contentHash: "b".repeat(64) }) }), /stale workspace/u);
  await assert.rejects(currentDesignLanguageModelContext(project, undefined, undefined, deps), /Reconnect/u);
  await assert.rejects(currentDesignLanguageModelContext(project, "/workspace", { id: "intent:one", turnId: "user:one", createdAt: 1, request: { version: 1, operation: "explore", count: 2, creativeRange: "balanced", aspects: [] } }, deps), /changed/u);
  project.designLanguages![0]!.document = { ...document, name: "Tampered" };
  await assert.rejects(currentDesignLanguageModelContext(project, "/workspace", undefined, deps), /damaged/u);
});


test("workspace adapter projects a portable subset without source paths and retains exact provenance", () => {
  const snapshot = { id: "snapshot:portable", revision: 2, contentHash: "c".repeat(64), name: "Workspace", tokens: { colors: [{ name: "color.primary", value: "#123456", sourceHash: "d".repeat(64) }, { name: "color.dynamic", value: "var(--external)" }], spacing: [{ name: "space.small", value: "8px" }], radii: [], typography: [{ name: "type.body", size: "16px" }], shadows: [] }, components: [], icons: [], sourceHashes: ["d".repeat(64)] } as unknown as DesignSystemSnapshotV1;
  const result = designLanguageFromWorkspaceSnapshot(snapshot);
  assert.equal(result.document.tokens.colors["color.primary"], "#123456");
  assert.equal(result.document.tokens.colors["color.dynamic"], undefined);
  assert.deepEqual(result.provenance, { kind: "workspace-snapshot", id: snapshot.id, revision: 2, contentHash: snapshot.contentHash });
  assert.doesNotMatch(JSON.stringify(result.document), /sourceHash|workspaceRelativePath/u);
});
