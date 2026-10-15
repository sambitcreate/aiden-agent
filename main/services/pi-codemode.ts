import { CodemodeSandbox, DEFAULT_INPUT_SCHEMA_MAX_CHARS, renderDeclarations, schemaToType, toCodemodeIdentifier, type CodemodeOutputItem } from "@earendil-works/pi-codemode";
import type { AgentTool, AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import { Type, type Usage } from "@earendil-works/pi-ai";
import { isPiCodemodeCallable } from "./pi-runtime-tool.js";
import { validateDisplayImageDimensions } from "./display-image-extension.js";
import { createPiToolDiscovery } from "./pi-tool-discovery.js";
import { captureMcpScriptResult } from "./mcp-tool-result.js";

export interface PiCodemodeHost {
  tools(): readonly AgentTool[];
  executeTool(parentToolCallId: string, name: string, args: unknown, signal: AbortSignal): Promise<AgentToolCallOutcome>;
  /**
   * Resolve once tools still being discovered (MCP servers that missed the
   * turn's start) have arrived or given up. Bounded by the host; rejects when
   * `signal` aborts. Omitted when the inventory is complete from the start.
   */
  settled?(signal?: AbortSignal): Promise<void>;
}

const DISCOVERY_GLOBALS = /\b(?:searchTools|describeTool|describeNamespace|ALL_TOOLS)\b/u;
const TOOL_REFERENCE = /\btools\b(\s*\.\s*([A-Za-z_$][\w$]*))?/gu;

/**
 * Whether a script might reach a tool that is not callable yet: it searches or
 * lists tools, or names `tools` in any way other than `tools.<known name>`.
 * Scripts that only call tools already available start without waiting.
 */
/**
 * Lay out script output the way Pi does, so the model can tell items apart:
 * with several `text()` items each starts with a `==> text N/M <==` line, and
 * `console.*` lines follow everything else in one `<console_output>` block.
 */
export function layoutCodemodeOutput(output: readonly CodemodeOutputItem[]): CodemodeOutputItem[] {
  const total = output.filter((item) => item.type === "text" && !item.console).length;
  const items: CodemodeOutputItem[] = [];
  const consoleLines: string[] = [];
  let index = 0;
  for (const item of output) {
    if (item.type === "image") items.push(item);
    else if (item.console) consoleLines.push(item.text);
    else {
      index += 1;
      items.push({ type: "text", text: total > 1 ? `==> text ${index}/${total} <==\n${item.text}` : item.text });
    }
  }
  if (consoleLines.length > 0) items.push({ type: "text", text: `<console_output>\n${consoleLines.join("\n")}\n</console_output>` });
  return items;
}

export function codemodeScriptMayNeedPendingTools(code: string, available: ReadonlySet<string>): boolean {
  if (DISCOVERY_GLOBALS.test(code)) return true;
  for (const match of code.matchAll(TOOL_REFERENCE)) {
    if (match[2] === undefined || !available.has(match[2])) return true;
  }
  return false;
}

const MAX_SCRIPT_CHARS = 64_000;
const MAX_RESULT_CHARS = 32_000;
const MAX_CALLS = 128;
export const MAX_CODEMODE_TOOLS = 512;
const MAX_DESCRIBE_CHARS = 16_000;
/** Raw output schemas above this are not even rendered; scripts see `unknown` structured content. */
const MAX_OUTPUT_SCHEMA_JSON_CHARS = 64_000;

/**
 * Content blocks as one compact type with the fields scripts read most
 * (`image(block)` takes an image block as is).
 */
const CONTENT_BLOCK_SCHEMA = {
  type: "object",
  properties: {
    type: { enum: ["text", "image", "audio", "resource_link", "resource"] },
    text: { type: "string" },
    data: { type: "string" },
    mimeType: { type: "string" },
  },
  required: ["type"],
  additionalProperties: true,
};
/** Keywords whose values are data, so a `$ref` key in them is not a reference. */
const SCHEMA_DATA_KEYWORDS: ReadonlySet<string> = new Set(["const", "enum", "default", "examples"]);
/** Keywords whose values map names to schemas, so their keys are names, not keywords. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set(["properties", "patternProperties", "dependentSchemas", "dependencies", "$defs", "definitions"]);

/** `schema` moved to `pointer` inside another schema, with its local `$ref`s rewritten to resolve there. */
function relocateSchema(schema: unknown, pointer: string): unknown {
  if (Array.isArray(schema)) return schema.map((item) => relocateSchema(item, pointer));
  if (typeof schema !== "object" || schema === null) return schema;
  const relocated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref" && typeof value === "string" && (value === "#" || value.startsWith("#/"))) relocated[key] = `${pointer}${value.slice(1)}`;
    else if (SCHEMA_DATA_KEYWORDS.has(key)) relocated[key] = value;
    else if (SCHEMA_MAP_KEYWORDS.has(key) && typeof value === "object" && value !== null && !Array.isArray(value)) {
      relocated[key] = Object.fromEntries(Object.entries(value).map(([name, subschema]) => [name, relocateSchema(subschema, pointer)]));
    } else relocated[key] = relocateSchema(value, pointer);
  }
  return relocated;
}

function resultSchema(structured: unknown): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      content: { type: "array", items: CONTENT_BLOCK_SCHEMA },
      // Results may carry structured content without a declared schema, and it may be any JSON value.
      structuredContent: structured ?? {},
      isError: { type: "boolean" },
    },
    required: ["content", "isError"],
    additionalProperties: true,
  };
}

/**
 * The declared type of what a script's `await tools.x(args)` resolves to:
 * `{content, structuredContent, isError}`, with the tool's own `outputSchema`
 * (the schema of its structured content) in place. Schemas too large to
 * render within the input-type budget fall back to `unknown` structured content.
 */
export function codemodeResultSchema(outputSchema: unknown): Record<string, unknown> {
  if (typeof outputSchema !== "object" || outputSchema === null || Array.isArray(outputSchema)) return resultSchema(undefined);
  let size: number;
  try { size = JSON.stringify(outputSchema).length; } catch { return resultSchema(undefined); }
  if (size > MAX_OUTPUT_SCHEMA_JSON_CHARS) return resultSchema(undefined);
  const schema = resultSchema(relocateSchema(outputSchema, "#/properties/structuredContent"));
  return schemaToType(schema, { maxChars: DEFAULT_INPUT_SCHEMA_MAX_CHARS }) === "unknown" ? resultSchema(undefined) : schema;
}

const resultSchemas = new WeakMap<AgentTool, Record<string, unknown>>();
function resultSchemaFor(tool: AgentTool): Record<string, unknown> {
  let schema = resultSchemas.get(tool);
  if (!schema) resultSchemas.set(tool, schema = codemodeResultSchema(tool.outputSchema));
  return schema;
}

/**
 * Keep at most {@link MAX_CODEMODE_TOOLS}: host tools first (they carry no
 * discovery namespace), then MCP tools in inventory order.
 */
function capTools(tools: readonly AgentTool[]): { tools: AgentTool[]; omitted: number } {
  if (tools.length <= MAX_CODEMODE_TOOLS) return { tools: [...tools], omitted: 0 };
  const discovered = (tool: AgentTool) => Boolean((tool as { discovery?: unknown }).discovery);
  const ordered = [...tools.filter((tool) => !discovered(tool)), ...tools.filter(discovered)];
  return { tools: ordered.slice(0, MAX_CODEMODE_TOOLS), omitted: tools.length - MAX_CODEMODE_TOOLS };
}

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
  const callableTools = () => host.tools().filter(isPiCodemodeCallable);
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
      let callable = callableTools();
      if (host.settled && codemodeScriptMayNeedPendingTools(code, new Set(callable.map(({ name }) => name)))) {
        // searchTools, describeTool and the `tools` namespace must see servers
        // that finished discovery after the turn started.
        await host.settled(signal);
        callable = callableTools();
      }
      // A huge inventory degrades to a capped one instead of disabling codemode.
      const capped = capTools(callable);
      callable = capped.tools;
      let calls = 0;
      let usage: Usage | undefined;
      let terminate = false;
      const pending = new Set<Promise<unknown>>();
      const definitions = callable.map((tool) => ({
        name: tool.name,
        description: tool.description.slice(0, 1024),
        inputSchema: tool.parameters as unknown as Record<string, unknown>,
        outputSchema: resultSchemaFor(tool),
        execute(parameters: unknown, context: { signal: AbortSignal }) {
          if (++calls > MAX_CALLS) throw new Error("Codemode is limited to 128 tool calls per script.");
          const operation = (async () => {
            context.signal.throwIfAborted();
            // MCP tools hand scripts their full (bounded) result; only the
            // codemode output the script produces is capped for the model.
            const { outcome, script } = await captureMcpScriptResult(() => host.executeTool(parentToolCallId, tool.name, parameters, context.signal));
            if (outcome.result.usage) usage = addUsage(usage, outcome.result.usage);
            if (outcome.result.terminate) terminate = true;
            if (script) return script;
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
            if (typeof name !== "string") throw new Error("describeTool expects a tool name.");
            // Scripts call tools by identifier (`my_tool` for `my-tool`); accept either spelling.
            let tool = definitions.find((entry) => entry.name === name);
            if (!tool) {
              const identifier = toCodemodeIdentifier(name);
              const matches = definitions.filter((entry) => toCodemodeIdentifier(entry.name) === identifier);
              if (matches.length > 1) throw new Error("Ambiguous tool identifier; pass the exact name from ALL_TOOLS.");
              tool = matches[0];
            }
            if (!tool) throw new Error("Unknown tool; find an available name in ALL_TOOLS.");
            const full = renderDeclarations({ tools: [tool] });
            if (full.length <= MAX_DESCRIBE_CHARS) return full;
            // Too long: drop the structured result type, then the argument type, rather than cut mid-declaration.
            const lean = renderDeclarations({ tools: [{ ...tool, outputSchema: resultSchema(undefined) }] });
            if (lean.length <= MAX_DESCRIBE_CHARS) return lean;
            return renderDeclarations({ tools: [{ ...tool, inputSchema: undefined, outputSchema: resultSchema(undefined) }] }).slice(0, MAX_DESCRIBE_CHARS);
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
        let limitNoticed = false;
        for (const item of layoutCodemodeOutput(result.output)) {
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
            else if (!limitNoticed) {
              limitNoticed = true;
              content.push({ type: "text", text: "Additional codemode images omitted: output limit." });
            }
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
        if (capped.omitted) content.push({ type: "text", text: `[Codemode: ${capped.omitted} tools omitted above the ${MAX_CODEMODE_TOOLS}-tool limit; disable unused MCP servers to reach them.]` });
        return { content, details: { calls: result.calls, ...(capped.omitted ? { omittedTools: capped.omitted } : {}) }, isError: !result.ok || invalidImage, ...(usage ? { usage } : {}), ...(terminate ? { terminate: true } : {}) };
      } finally {
        await sandbox.close();
        await Promise.allSettled([...pending]);
      }
    },
  };
}
