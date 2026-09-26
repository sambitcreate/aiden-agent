/** Desktop Settings status only; advertised metadata never grants runtime access. */
export interface McpStatus {
  connected: boolean;
  toolCount: number;
  tools: string[];
  error?: string;
  /** Initialize metadata, independent of tool discovery; null if initialization failed. */
  serverCapabilities: Record<string, unknown> | null;
  /** For OAuth servers: whether valid tokens are stored. */
  authorized?: boolean;
}
