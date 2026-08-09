import type { McpServer } from "../types.js";
import type { SubagentMcpClientPort, SubagentMcpRemoteTool } from "./subagent-mcp-read.js";
import type {
  SubagentMcpCredentialBoundary,
  SubagentMcpCredentialRedactor,
} from "./subagent-mcp-credential-core.js";

export const SUBAGENT_MCP_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_SUBAGENT_MCP_CLIENT_REDACTORS = 512;

interface RequestOptions {
  signal: AbortSignal;
  timeout: number;
  maxTotalTimeout: number;
}

export interface IsolatedSubagentMcpSdkClient {
  connect(transport: unknown, options: RequestOptions): Promise<void>;
  close(): Promise<void>;
  listTools(
    params: undefined,
    options: RequestOptions,
  ): Promise<{ tools: readonly SubagentMcpRemoteTool[] }>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema: undefined,
    options: RequestOptions,
  ): Promise<unknown>;
}

export interface IsolatedSubagentMcpClientDependencies {
  createClient(): IsolatedSubagentMcpSdkClient;
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

function redactTextResult(result: unknown, boundary: SubagentMcpCredentialBoundary): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.content)) return result;
  return {
    ...record,
    content: record.content.map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return part;
      const content = part as Record<string, unknown>;
      return content.type === "text" && typeof content.text === "string"
        ? { ...content, text: boundary.redactText(content.text) }
        : part;
    }),
  };
}

/** Isolated SDK lifecycle; credentials and transports remain behind injected main-owned ports. */
export async function withIsolatedSubagentMcpClientCore<T>(input: {
  server: McpServer;
  signal: AbortSignal;
  configurationLease: SubagentMcpConfigurationLease;
  operation: (client: SubagentMcpClientPort) => Promise<T>;
  dependencies: IsolatedSubagentMcpClientDependencies;
}): Promise<T> {
  if (input.signal.aborted) throw abortReason(input.signal);
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
        timeout: SUBAGENT_MCP_REQUEST_TIMEOUT_MS,
        maxTotalTimeout: SUBAGENT_MCP_REQUEST_TIMEOUT_MS,
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
        // the SDK instruction that emits raw connection request bytes.
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
        return await input.operation({
          credentialRevision: credentialBoundary.revision,
          credentialRevisionIsCurrent,
          redactCredentialText,
          listTools: async (requestSignal) => {
            if (requestSignal.aborted) throw abortReason(requestSignal);
            // Exact synchronous fence immediately before raw SDK request.
            assertRawRequestCurrent(input.configurationLease, requestSignal);
            const { tools } = await client.listTools(undefined, requestOptions(requestSignal));
            if (!(await credentialRevisionIsCurrent(requestSignal))) {
              throw new Error("MCP credential revision changed.");
            }
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
          callTool: (toolName, args, requestSignal, beforeEffect) => {
            if (requestSignal.aborted) {
              return Promise.reject(abortReason(requestSignal));
            }
            return credentialRevisionIsCurrent(requestSignal).then(async (current) => {
              if (!current) throw new Error("MCP credential revision changed.");
              beforeEffect?.();
              // No await may be inserted between this main-owned config
              // fence and the SDK instruction that emits raw request bytes.
              assertRawRequestCurrent(input.configurationLease, requestSignal);
              const result = await client.callTool(
                { name: toolName, arguments: args },
                undefined,
                requestOptions(requestSignal),
              );
              const currentBoundary = await input.dependencies.resolveCredentialBoundary(
                input.server,
                requestSignal,
              );
              if (currentBoundary.revision !== credentialBoundary.revision) {
                throw new Error("MCP credential revision changed.");
              }
              registerCredentialRedactor(currentBoundary.redactText);
              return redactTextResult(result, {
                revision: currentBoundary.revision,
                redactText: redactCredentialText,
              });
            });
          },
          callToolRaw: (toolName, args, requestSignal, beforeRawBytes) => {
            // This mutation-only path is valid only after the caller has
            // reinspected the exact credential-bound inventory on this client.
            // No await may be inserted between these fences and the one SDK
            // invocation that can emit request bytes.
            assertRawRequestCurrent(input.configurationLease, requestSignal);
            beforeRawBytes();
            const raw = client.callTool(
              { name: toolName, arguments: args },
              undefined,
              requestOptions(requestSignal),
            );
            return raw.then(async (result) => {
              const currentBoundary = await input.dependencies.resolveCredentialBoundary(
                input.server,
                requestSignal,
              );
              if (currentBoundary.revision !== credentialBoundary.revision) {
                throw new Error("MCP credential revision changed.");
              }
              registerCredentialRedactor(currentBoundary.redactText);
              return redactTextResult(result, {
                revision: currentBoundary.revision,
                redactText: redactCredentialText,
              });
            });
          },
        });
      } finally {
        input.signal.removeEventListener("abort", closeOnAbort);
        await client.close().catch(() => undefined);
      }
    },
    active,
  );
}
