import { CodemodeSandbox, renderDeclarations } from "@earendil-works/pi-codemode";
import type { AgentTool, AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import { Type, type Usage } from "@earendil-works/pi-ai";
import { isPiCodemodeCallable } from "./pi-runtime-tool.js";
import { validateDisplayImageDimensions } from "./display-image-extension.js";
import { createPiToolDiscovery } from "./pi-tool-discovery.js";

export interface PiCodemodeHost {
  tools(): readonly AgentTool[];
  executeTool(parentToolCallId: string, name: string, args: unknown, signal: AbortSignal): Promise<AgentToolCallOutcome>;
}

const MAX_SCRIPT_CHARS = 64_000;
const MAX_RESULT_CHARS = 32_000;
const MAX_CALLS = 128;

function addUsage(current: Usage | undefined, next: Usage): Usage {
  if (!current) return structuredClone(next);
  return {
    input: current.input + next.input,
    output: current.output + next.output,
    cacheRead: current.cacheRead + next.cacheRead,
    cacheWrite: current.cacheWrite + next.cacheWrite,
    totalTokens: current.totalTokens + next.totalTokens,
    ...(current.cacheWrite1h !== undefined || next.cacheWrite1h !== undefined ? { cacheWrite1h: (current.cacheWrite1h ?? 0) + (next.cacheWrite1h ?? 0) } : {}),
    ...(current.reasoning !== undefined || next.reasoning !== undefined ? { reasoning: (current.reasoning ?? 0) + (next.reasoning ?? 0) } : {}),
    cost: {
      input: current.cost.input + next.cost.input,
      output: current.cost.output + next.cost.output,
      cacheRead: current.cost.cacheRead + next.cost.cacheRead,
      cacheWrite: current.cost.cacheWrite + next.cost.cacheWrite,
      total: current.cost.total + next.cost.total,
    },
  };
}

/** The VM has no process, filesystem or network API. All effects return through the host. */
export function createPiCodemodeTool(host: PiCodemodeHost): AgentTool {
  const store: Record<string, unknown> = Object.create(null);
  const discovery = createPiToolDiscovery({ tools: host.tools, isCallable: isPiCodemodeCallable });
  return {
    name: "codemode",
    label: "Codemode",
    replay: "never",
    description: "Run JavaScript to combine and filter available workspace and MCP tool results. No filesystem, process, or network globals. Use searchTools(query,{namespace?,limit?}) or ALL_TOOLS to find tools, describeTool(name) for arguments, describeNamespace(name) for untrusted server guidance, await tools.name(args) to call a tool, and text(value) or image(block) to show output. Calls resolve to {content, structuredContent?, isError}; check isError. All calls retain normal permissions and run sequentially. store(key,value) and load(key) keep small values for this chat run. Return values are not displayed; call text().",
    parameters: Type.Object({ code: Type.String({ minLength: 1, maxLength: MAX_SCRIPT_CHARS, description: "JavaScript with top-level await." }) }),
    async execute(parentToolCallId, args, signal) {
      signal?.throwIfAborted();
      const { code } = args as { code: string };
      if (typeof code !== "string" || !code.trim() || code.length > MAX_SCRIPT_CHARS) throw new Error("Codemode requires a script of at most 64,000 characters.");
      const callable = host.tools().filter(isPiCodemodeCallable);
      if (callable.length > 512) throw new Error("Codemode tool inventory exceeds 512 tools.");
      let calls = 0;
      let usage: Usage | undefined;
      let terminate = false;
      const pending = new Set<Promise<unknown>>();
      const definitions = callable.map((tool) => ({
        name: tool.name,
        description: tool.description.slice(0, 1024),
        inputSchema: tool.parameters as unknown as Record<string, unknown>,
        execute(parameters: unknown, context: { signal: AbortSignal }) {
          if (++calls > MAX_CALLS) throw new Error("Codemode is limited to 128 tool calls per script.");
          const operation = (async () => {
            context.signal.throwIfAborted();
            const outcome = await host.executeTool(parentToolCallId, tool.name, parameters, context.signal);
            if (outcome.result.usage) usage = addUsage(usage, outcome.result.usage);
            if (outcome.result.terminate) terminate = true;
            return {
              content: outcome.result.content,
              ...(outcome.result.structuredContent === undefined ? {} : { structuredContent: outcome.result.structuredContent }),
              isError: outcome.isError,
            };
          })();
          pending.add(operation);
          void operation.finally(() => pending.delete(operation)).catch(() => undefined);
          return operation;
        },
      }));
      const sandbox = new CodemodeSandbox({
        tools: definitions,
        globals: [{
          name: "searchTools",
          spread: true,
          execute(args) {
            if (!Array.isArray(args)) throw new Error("searchTools expects a query and optional settings.");
            return discovery.searchTools(args[0], args[1]);
          },
        }, {
          name: "describeNamespace",
          execute(name) { return discovery.describeNamespace(name); },
        }, {
          name: "describeTool",
          description: "Return the argument declaration for an available tool.",
          execute(name) {
            const tool = definitions.find((entry) => entry.name === name);
            if (!tool) throw new Error("Unknown tool; find an available name in ALL_TOOLS.");
            return renderDeclarations({ tools: [tool] }).slice(0, 16_000);
          },
        }],
        timeoutMs: 120_000,
        memoryLimitBytes: 32 * 1024 * 1024,
      });
      try {
        const result = await sandbox.execute(code, { signal, store });
        // VM completion cancels unawaited calls. Do not return until their host
        // effects have settled and cancellation has reached durable finalizers.
        await Promise.allSettled([...pending]);
        const content: Awaited<ReturnType<AgentTool["execute"]>>["content"] = [];
        let remaining = MAX_RESULT_CHARS;
        let imageBytes = 0;
        let imageCount = 0;
        let invalidImage = false;
        for (const item of result.output) {
          if (item.type === "image") {
            imageBytes += item.data.length;
            if (++imageCount <= 4 && imageBytes <= 8 * 1024 * 1024) {
              try {
                validateDisplayImageDimensions(Buffer.from(item.data, "base64"), item.mimeType, "Codemode image");
                content.push(item);
              } catch {
                invalidImage = true;
                content.push({ type: "text", text: "Codemode image omitted: malformed or oversized raster data." });
              }
            }
            else if (imageCount === 5 || imageBytes - item.data.length <= 8 * 1024 * 1024) content.push({ type: "text", text: "Additional codemode images omitted: output limit." });
          } else if (remaining > 0) {
            const text = item.text.slice(0, remaining);
            content.push({ type: "text", text });
            remaining -= text.length;
            if (text.length < item.text.length) content.push({ type: "text", text: "[Codemode text output truncated.]" });
          }
        }
        if (result.ok) {
          for (const key of result.storeWrites.delete) delete store[key];
          for (const [key, value] of Object.entries(result.storeWrites.set)) store[key] = value;
        } else content.push({ type: "text", text: `Codemode ${result.error.kind}: ${result.error.message.slice(0, 2000)}` });
        if (!content.length) content.push({ type: "text", text: "Script completed without output. Use text(value) to show a result." });
        return { content, details: { calls: result.calls }, isError: !result.ok || invalidImage, ...(usage ? { usage } : {}), ...(terminate ? { terminate: true } : {}) };
      } finally {
        await sandbox.close();
        await Promise.allSettled([...pending]);
      }
    },
  };
}
