export interface DesignStudioExportRequest {
  projectId: string;
  mediaIds: string[];
  referenceAssetIds: string[];
  brief: string;
  accessibilityNotes: string;
  includeLanguage: boolean;
  includePrototype: boolean;
}
export interface DesignStudioExportPreview {
  projectRevision: number;
  reviewDigest: string;
  fileName: string;
  entryPaths: string[];
  manifestJson: string;
  briefMarkdown: string;
  designMarkdown: string;
  byteSize: number;
}
