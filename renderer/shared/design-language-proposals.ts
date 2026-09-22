import type { DesignLanguageDocumentV1, DesignLanguageProvenanceV1 } from "./design-language";
export interface DesignLanguageProposalInput {
  projectId: string;
  mode: "describe" | "import" | "derive" | "workspace" | "merge";
  document?: DesignLanguageDocumentV1;
  text?: string;
  mediaId?: string;
  baseLanguageId?: string;
}
export interface DesignLanguageProposal {
  document: DesignLanguageDocumentV1;
  provenance: DesignLanguageProvenanceV1;
  contentHash: string;
  reviewHash: string;
  markdown: string;
}
