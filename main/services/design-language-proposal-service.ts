import { createHash } from "node:crypto";
import type { DesignProjectSnapshotV2 } from "../../renderer/shared/design-projects.js";
import type { DesignLanguageProposal, DesignLanguageProposalInput } from "../../renderer/shared/design-language-proposals.js";
import { normalizeDesignLanguageDocument, designLanguageContentHash, importDesignLanguageMarkdown, exportDesignLanguageMarkdown, mergeDesignLanguageDocuments } from "./design-language-core.js";

export async function prepareDesignLanguageProposal(project: DesignProjectSnapshotV2, input: DesignLanguageProposalInput, sources: {
  derive: (mediaId: string) => Promise<Pick<DesignLanguageProposal, "document" | "provenance">>;
  workspace: () => Promise<Pick<DesignLanguageProposal, "document" | "provenance">>;
}): Promise<DesignLanguageProposal> {
  if (!input || typeof input !== "object" || input.projectId !== project.id || Object.keys(input).some(key => !["projectId","mode","document","text","mediaId","baseLanguageId"].includes(key))) throw new Error("Invalid Design Language proposal.");
  let result: Pick<DesignLanguageProposal,"document"|"provenance">;
  switch(input.mode) {
    case "describe": result={document:normalizeDesignLanguageDocument(input.document),provenance:{kind:"authored"}};break;
    case "import": result={document:importDesignLanguageMarkdown(input.text),provenance:{kind:"imported"}};break;
    case "derive":
      if (typeof input.mediaId !== "string" || input.mediaId.length > 256) throw new Error("Choose an exact Screen revision.");
      result=await sources.derive(input.mediaId);break;
    case "workspace": result=await sources.workspace();break;
    case "merge": {
      const base=project.designLanguages?.find(language=>language.id===input.baseLanguageId);
      if (!base) throw new Error("Choose a saved language to merge.");
      result={document:mergeDesignLanguageDocuments(base.document,input.document),provenance:{kind:"authored"}};break;
    }
    default: throw new Error("Invalid Design Language action.");
  }
  const document=normalizeDesignLanguageDocument(result.document);
  return {document,provenance:result.provenance,contentHash:designLanguageContentHash(document),reviewHash:createHash("sha256").update(JSON.stringify({document,provenance:result.provenance})).digest("hex"),markdown:exportDesignLanguageMarkdown(document)};
}
