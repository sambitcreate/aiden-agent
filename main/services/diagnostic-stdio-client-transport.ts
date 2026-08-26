import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ChildProcess } from "node:child_process";
import { trackDiagnosticChild } from "./performance-child.js";

/** Preserve the SDK transport while observing the exact helper it owns. */
export class DiagnosticStdioClientTransport extends StdioClientTransport {
  override start(): Promise<void> {
    const starting = super.start();
    const child = (this as unknown as { _process?: ChildProcess })._process;
    if (child) trackDiagnosticChild("mcp-stdio", child);
    return starting;
  }
}
