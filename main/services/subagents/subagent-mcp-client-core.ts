import type { McpClient, McpTransport } from "@earendil-works/pi-mcp";
import { connectMcpClient } from "../mcp-client.js";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { McpServer } from "../types.js";
import { copyBoundedJson, utf8Size } from "../bounded-json.js";
import { callMcpTool, createMcpToolCallGuard, listMcpToolInventory, listMcpToolPage, readGuardedMcpInventory, MCP_TOOL_LIST_CHANGED, type McpSkippedToolReporter } from "../mcp-tool-inventory.js";
import { McpToolCallNotSentError } from "./subagent-effect-v2.js";
import type { SubagentMcpClientPort, SubagentMcpRemoteTool } from "./subagent-mcp-read.js";
import type {
  SubagentMcpCredentialBoundary,
  SubagentMcpCredentialRedactor,
} from "./subagent-mcp-credential-core.js";

export const SUBAGENT_MCP_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_SUBAGENT_MCP_CLIENT_REDACTORS = 512;

interface RequestOptions {
  signal: AbortSignal;
  timeoutMs: number;
}

/** One isolated MCP client connection, as the main process drives it. */
export interface IsolatedSubagentMcpClient {
  readonly inventoryRevision?: number;
  connect(transport: unknown, options: RequestOptions): Promise<void>;
  close(): Promise<void>;
  /** One raw tools/list page. */
  listTools(
    cursor: string | undefined,
    options: RequestOptions,
  ): Promise<{ tools: readonly SubagentMcpRemoteTool[]; nextCursor?: string }>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    options: RequestOptions & { beforeSend(): void },
  ): Promise<unknown>;
}

export function isolatedSubagentMcpClient(client: McpClient, onSkip?: McpSkippedToolReporter): IsolatedSubagentMcpClient {
  let inventoryRevision = 0;
  client.onNotification(MCP_TOOL_LIST_CHANGED, () => { inventoryRevision++; });
  return {
    get inventoryRevision() { return inventoryRevision; },
    connect: (transport, options) => connectMcpClient(client, transport as McpTransport, options),
    close: () => client.close(),
    listTools: (cursor, options) => listMcpToolPage(client, cursor, options, onSkip),
    callTool: (params, options) => callMcpTool(client, params, options),
  };
}

export interface IsolatedSubagentMcpClientDependencies {
  createClient(): IsolatedSubagentMcpClient;
  resolveAuth(server: McpServer, isCurrent: () => boolean): Promise<McpServer>;
  resolveCredentialBoundary(
    server: McpServer,
    signal: AbortSignal,
  ): Promise<SubagentMcpCredentialBoundary>;
  makeTransport(
    server: McpServer,
    isCurrent: () => boolean,
    options: {
      forceNoRedirect: true;
      registerCredentialRedactor(redactor: SubagentMcpCredentialRedactor): void;
    },
  ): unknown;
  withConfigured<T>(
    server: McpServer,
    operation: () => Promise<T>,
    isCurrent: () => boolean,
  ): Promise<T>;
  /** Child agents read results as received; a result that breaks its output schema is reported here. */
  reportOutputSchemaDiagnostic?(diagnostic: string): void;
}

export interface SubagentMcpConfigurationLease {
  readonly signal: AbortSignal;
  assertCurrent(): void;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("MCP read cancelled.");
}

function assertRawRequestCurrent(lease: SubagentMcpConfigurationLease, signal: AbortSignal): void {
  lease.assertCurrent();
  if (signal.aborted) throw abortReason(signal);
}

/** Child results never carry more structured data than this, before redaction. */
export const MAX_CHILD_STRUCTURED_BYTES = 256 * 1024;

/**
 * Bounded copy of structured content with every string value and key passed
 * through the credential redactor, or undefined when it cannot be copied
 * within bounds (unredactable data never reaches a child).
 */
export function redactStructuredContent(value: unknown, redact: (text: string) => string): JsonValue | undefined {
  const copy = copyBoundedJson(value, { maxNodes: 4096, maxDepth: 32, maxSize: MAX_CHILD_STRUCTURED_BYTES, measure: utf8Size, ordinaryObjects: true });
  if (copy === undefined) return undefined;
  const walk = (entry: JsonValue): JsonValue => {
    if (typeof entry === "string") return redact(entry);
    if (Array.isArray(entry)) return entry.map(walk);
    if (entry && typeof entry === "object") {
      const output: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(entry)) {
        Object.defineProperty(output, redact(key), { value: walk(item), enumerable: true, writable: true, configurable: true });
      }
      return output;
    }
    return entry;
  };
  return walk(copy);
}

function redactTextResult(result: unknown, boundary: SubagentMcpCredentialBoundary): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  const structured = record.structuredContent === undefined
    ? undefined : redactStructuredContent(record.structuredContent, (text) => boundary.redactText(text));
  const { structuredContent: _raw, ...rest } = record;
  return {
    ...rest,
    ...(structured === undefined ? {} : { structuredContent: structured }),
    ...(Array.isArray(record.content) ? {
      content: record.content.map((part) => {
        if (!part || typeof part !== "object" || Array.isArray(part)) return part;
        const content = part as Record<string, unknown>;
        return content.type === "text" && typeof content.text === "string"
          ? { ...content, text: boundary.redactText(content.text) }
          : part;
      }),
    } : {}),
  };
}

/** Isolated MCP client lifecycle; credentials and transports remain behind injected main-owned ports. */
export async function withIsolatedSubagentMcpClientCore<T>(input: {
  server: McpServer;
  signal: AbortSignal;
  configurationLease: SubagentMcpConfigurationLease;
  operation: (client: SubagentMcpClientPort) => Promise<T>;
  dependencies: IsolatedSubagentMcpClientDependencies;
}): Promise<T> {
  if (input.signal.aborted) throw abortReason(input.signal);
  if (input.server.authProvider) throw new Error("Provider-authenticated MCP is unavailable to child agents.");
  if (input.server.transport === "stdio") {
    throw new Error("Subagent MCP requires an isolated remote transport.");
  }
  input.configurationLease.assertCurrent();
  const active = () => !input.signal.aborted;
  return input.dependencies.withConfigured(
    input.server,
    async () => {
      const client = input.dependencies.createClient();
      const closeOnAbort = () => {
        void client.close().catch(() => undefined);
      };
      input.signal.addEventListener("abort", closeOnAbort, { once: true });
      const requestOptions = (signal: AbortSignal): RequestOptions => ({
        signal,
        timeoutMs: SUBAGENT_MCP_REQUEST_TIMEOUT_MS,
      });
      try {
        const credentialBeforeConnect = await input.dependencies.resolveCredentialBoundary(
          input.server,
          input.signal,
        );
        const credentialRedactors = [credentialBeforeConnect.redactText];
        const registerCredentialRedactor = (redactor: SubagentMcpCredentialRedactor) => {
          if (credentialRedactors.length >= MAX_SUBAGENT_MCP_CLIENT_REDACTORS) {
            throw new Error("MCP credential redaction limit exceeded.");
          }
          credentialRedactors.push(redactor);
        };
        const redactCredentialText = (text: string): string =>
          credentialRedactors.reduce((redacted, redact) => redact(redacted), text);
        const authenticated = await input.dependencies.resolveAuth(input.server, active);
        const transport = input.dependencies.makeTransport(authenticated, active, {
          forceNoRedirect: true,
          registerCredentialRedactor,
        });
        // No await may be inserted between this main-owned config fence and
        // the client instruction that emits raw connection request bytes.
        assertRawRequestCurrent(input.configurationLease, input.signal);
        await client.connect(transport, requestOptions(input.signal));
        if (input.signal.aborted) throw abortReason(input.signal);
        const credentialBoundary = await input.dependencies.resolveCredentialBoundary(
          input.server,
          input.signal,
        );
        if (credentialBoundary.revision !== credentialBeforeConnect.revision) {
          throw new Error("MCP credential revision changed.");
        }
        registerCredentialRedactor(credentialBoundary.redactText);
        const credentialRevisionIsCurrent = async (signal: AbortSignal) => {
          if (signal.aborted) throw abortReason(signal);
          const current = await input.dependencies.resolveCredentialBoundary(input.server, signal);
          if (current.revision !== credentialBoundary.revision) return false;
          registerCredentialRedactor(current.redactText);
          return true;
        };
        let callGuard: ReturnType<typeof createMcpToolCallGuard> | undefined;
        const dispatch = async (
          toolName: string, args: Record<string, unknown>, signal: AbortSignal,
          firstSend?: () => void, beforeRetry?: () => void, mutation = false,
        ) => {
          const guard = callGuard;
          let attempted = false;
          const beforeSend = () => {
            assertRawRequestCurrent(input.configurationLease, signal);
            guard?.assertCallable(toolName);
            if (attempted) beforeRetry?.();
            else firstSend?.();
            assertRawRequestCurrent(input.configurationLease, signal);
            attempted = true;
          };
          let result: unknown;
          try {
            // Fail early on a known withdrawal. Recheck after all transport awaits.
            assertRawRequestCurrent(input.configurationLease, signal);
            guard?.assertCallable(toolName);
            result = await client.callTool({ name: toolName, arguments: args }, { ...requestOptions(signal), beforeSend });
          } catch (error) {
            if (mutation && !attempted) {
              throw new McpToolCallNotSentError(error instanceof Error ? error.message : "MCP call was not sent.");
            }
            throw error;
          }
          const current = await input.dependencies.resolveCredentialBoundary(input.server, signal);
          if (current.revision !== credentialBoundary.revision) throw new Error("MCP credential revision changed.");
          registerCredentialRedactor(current.redactText);
          // Advisory: the call already ran, so a schema mismatch must not read as a failure to retry.
          const diagnostic = guard?.validateResult(toolName, result, "advisory");
          if (diagnostic !== undefined) input.dependencies.reportOutputSchemaDiagnostic?.(diagnostic);
          return redactTextResult(result, { revision: current.revision, redactText: redactCredentialText });
        };
        return await input.operation({
          credentialRevision: credentialBoundary.revision,
          credentialRevisionIsCurrent,
          redactCredentialText,
          listTools: async (requestSignal) => {
            if (requestSignal.aborted) throw abortReason(requestSignal);
            const revision = client.inventoryRevision;
            const assertInventoryCurrent = () => {
              if (client.inventoryRevision !== revision) throw new Error("MCP tool inventory changed.");
            };
            const { tools, guard } = await readGuardedMcpInventory(client, () => listMcpToolInventory({
              signal: AbortSignal.any([requestSignal, input.signal, input.configurationLease.signal]),
              assertCurrent: () => {
                assertInventoryCurrent();
                assertRawRequestCurrent(input.configurationLease, requestSignal);
              },
              listPage: async (cursor, pageSignal) => {
                // Exact synchronous fence immediately before each raw MCP request.
                assertRawRequestCurrent(input.configurationLease, pageSignal);
                const result = await client.listTools(cursor, requestOptions(pageSignal));
                if (!(await credentialRevisionIsCurrent(pageSignal))) throw new Error("MCP credential revision changed.");
                return result;
              },
            }), assertInventoryCurrent);
            callGuard = guard;
            return tools.map(
              ({ name, description, inputSchema, outputSchema, annotations, execution }) => ({
                name,
                ...(description === undefined ? {} : { description }),
                ...(inputSchema === undefined ? {} : { inputSchema }),
                ...(outputSchema === undefined ? {} : { outputSchema }),
                ...(annotations === undefined ? {} : { annotations }),
                ...(execution === undefined ? {} : { execution }),
              }),
            );
          },
          callTool: async (toolName, args, signal, beforeEffect, beforeRetry) => {
            if (!(await credentialRevisionIsCurrent(signal))) throw new Error("MCP credential revision changed.");
            return dispatch(toolName, args, signal, beforeEffect, beforeRetry);
          },
          callToolRaw: (name, args, signal, beforeBytes, beforeRetry) =>
            dispatch(name, args, signal, beforeBytes, beforeRetry, true),
        });
      } finally {
        input.signal.removeEventListener("abort", closeOnAbort);
        await client.close().catch(() => undefined);
      }
    },
    active,
  );
}
