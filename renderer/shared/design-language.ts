/** Inert semantic design data. It never grants file, network, or tool authority. */
export interface DesignLanguageDocumentV1 {
  version: 1;
  name: string;
  guidance: string;
  tokens: {
    colors: Record<string, string>;
    spacing: Record<string, string>;
    typography: Record<string, string>;
    radii: Record<string, string>;
  };
}
export type DesignLanguageProvenanceV1 =
  | { kind: "authored" }
  | { kind: "imported" }
  | { kind: "derived"; lineageId: string; mediaId: string; contentHash: string }
  | { kind: "workspace-snapshot"; id: string; revision: number; contentHash: string };
export interface DesignLanguageBindingV1 { id: string; revision: number; contentHash: string }
export interface DesignLanguageSnapshotV1 extends DesignLanguageBindingV1 {
  document: DesignLanguageDocumentV1;
  provenance: DesignLanguageProvenanceV1;
  createdAt: number;
}

export function parseDesignLanguageBindingV1(value: unknown): DesignLanguageBindingV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const binding = value as Record<string, unknown>;
  if (Object.keys(binding).length !== 3 || typeof binding.id !== "string" ||
      !/^[A-Za-z0-9._:@+-]{1,256}$/.test(binding.id) ||
      !Number.isSafeInteger(binding.revision) || (binding.revision as number) < 1 ||
      typeof binding.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(binding.contentHash)) return undefined;
  return {id: binding.id, revision: binding.revision as number, contentHash: binding.contentHash};
}
