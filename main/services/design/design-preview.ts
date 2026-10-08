// Project-aware aiden-genui: resolver (ADR-DS §3), mirroring
// wrapStoredHtmlArtifact without touching the chat artifact store.
import { parseGenerativeUiTheme, wrapGenerativeUiHtml } from "../generative-ui-html.js";
import type { DesignProjectStore } from "./store.js";
import { DesignStoreError } from "./store-core.js";
import { isDesignId } from "./ops-parse.js";

export interface DesignPreviewDeps {
  store: Pick<DesignProjectStore, "readRevision">;
  /** registerGenerativeUiPreviewDocument in production. */
  register(body: string): string;
}

export async function wrapDesignRevision(
  deps: DesignPreviewDeps,
  input: { projectId: string; revisionId: string; theme?: unknown },
): Promise<{ src: string; title: string }> {
  // Ids are checked before they reach the store; anything malformed is simply not found.
  if (!isDesignId(input.projectId) || !isDesignId(input.revisionId)) {
    throw new DesignStoreError("not_found", "That revision no longer exists.");
  }
  // readRevision looks the revision up in the project's manifest and verifies size and digest,
  // recording a mismatch as missing.
  const revision = await deps.store.readRevision(input.projectId, input.revisionId);
  const body = wrapGenerativeUiHtml(revision.html, revision.title, parseGenerativeUiTheme(input.theme));
  return { src: deps.register(body), title: revision.title };
}
