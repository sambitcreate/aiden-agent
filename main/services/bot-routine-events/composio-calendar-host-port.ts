/** Trusted-code composition only. Installing this port is separate from editable diagnostics. */
import type { SubagentMcpRemoteTool } from "../subagents/subagent-mcp-read.js";
import type { ComposioCalendarRead, ComposioCalendarReadPort } from "./connector-watch-composio.js";

export interface ComposioCalendarContract {
  revision: "composio-calendar-v1";
  executorSchemaHash: string;
  readSchemaHashes: { listCalendars: string; listEvents: string; getEvent: string };
}
export interface ComposioCalendarTransportContext {
  phase: "foreground" | "background";
  /** Current selected live-client metadata, renewed only under protected source admission. */
  metadata: readonly SubagentMcpRemoteTool[];
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
  /** Fixed Calendar schema slugs only. No generic schema/tool dispatch. */
  getSchemas(sessionId?: string): Promise<unknown>;
  /** One fixed read with exact account; callable only during an admitted typed read. */
  execute(read: ComposioCalendarRead, sessionId?: string): Promise<unknown>;
  /** Fresh guarded Search is available only in explicit foreground discovery. */
  currentAccounts(): Promise<unknown>;
}
export interface ComposioCalendarHostTransport {
  /** Must validate installed executor/upstream schemas and real account routing.
   * Saved fingerprints and inspection files never establish this authority. */
  prepare(context: ComposioCalendarTransportContext, expected?: ComposioCalendarContract): Promise<{
    contract: ComposioCalendarContract;
    port: ComposioCalendarReadPort;
  }>;
}
let installed: ComposioCalendarHostTransport | undefined;
/** Host code installs only after reviewed real read/schema/account acceptance. */
export function installComposioCalendarHostTransport(transport: ComposioCalendarHostTransport): void {
  if (installed && installed !== transport) throw new Error("The Calendar host transport is already installed.");
  installed = transport;
}
export function composioCalendarHostTransport(): ComposioCalendarHostTransport | undefined { return installed; }
