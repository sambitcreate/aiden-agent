export const CUA_DRIVER_VERSION = "0.8.3";
export const CUA_DRIVER_TOOL_SCHEMA = "1";
export const CUA_DRIVER_CAPABILITY_VERSION = "1";
export const CUA_DRIVER_HOST_BUNDLE_ID = "com.sambitcreate.aiden-agent";
export const CUA_DRIVER_BROKER_BUNDLE_ID = "com.sambitcreate.aiden-agent.cua-driver";
export const CUA_DRIVER_BROKER_EXECUTABLE = "aiden-cua-broker";

export const CUA_DRIVER_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "start_session",
  "end_session",
  "health_report",
  "check_permissions",
  "list_apps",
  "list_windows",
  "get_screen_size",
  "get_accessibility_tree",
  "get_desktop_state",
  "get_window_state",
  "bring_to_front",
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
]);

/** Every allowed tool is required so native and TypeScript fail closed on contract drift. */
export const CUA_DRIVER_REQUIRED_TOOLS = CUA_DRIVER_ALLOWED_TOOLS;

export interface CuaDriverInvocation {
  /** Aiden's broker/bridge executable, resolved inside the signed helper app. */
  command: string;
  /** Test-only argv inserted before the bridge flags. */
  prefixArgs?: string[];
}

export interface CuaDriverManifest {
  schemaVersion: string;
  binaryVersion: string;
}

export interface CuaDriverToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
  capabilities: ReadonlySet<string>;
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  openWorld?: boolean;
}

export interface CuaDriverToolCatalog {
  tools: Map<string, CuaDriverToolInfo>;
  schemaVersion: string;
  capabilityVersion: string;
}

export class CuaDriverError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "CuaDriverError";
  }
}

/**
 * cua-driver is a privileged third-party child. Give it only the environment
 * needed for locale, temporary files, and the broker/proxy contract. In
 * particular, provider keys, OAuth tokens, Electron/Node injection flags,
 * dynamic-loader variables, and proxy credentials never cross this boundary.
 */
export function buildCuaDriverEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  hostBundleId = CUA_DRIVER_HOST_BUNDLE_ID,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    CUA_DRIVER_HOST_BUNDLE_ID: hostBundleId,
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
    CUA_TELEMETRY_ENABLED: "0",
    CUA_DRIVER_RS_UPDATE_CHECK: "false",
    NO_COLOR: "1",
  };
  for (const key of [
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "USER",
    "__CF_USER_TEXT_ENCODING",
  ]) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) env[key] = value;
  }
  return env;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Return whether this exact pinned tool schema accepts Aiden's generation
 * session id. Malformed or drifted object schemas are rejected rather than
 * guessing and sending an argument the driver did not declare.
 */
export function cuaDriverToolDeclaresSession(tool: CuaDriverToolInfo): boolean {
  const schema = asRecord(tool.inputSchema);
  const properties = asRecord(schema?.properties);
  if (
    schema?.type !== "object" ||
    typeof schema.additionalProperties !== "boolean" ||
    !properties
  ) {
    throw new CuaDriverError(
      "invalid_tools",
      `cua-driver returned a malformed input schema for ${tool.name}.`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(properties, "session")) return false;
  const sessionSchema = asRecord(properties.session);
  if (sessionSchema?.type !== "string") {
    throw new CuaDriverError(
      "invalid_tools",
      `cua-driver returned an invalid session schema for ${tool.name}.`,
    );
  }
  return true;
}

export function parseCuaDriverTools(value: unknown): CuaDriverToolCatalog {
  const response = asRecord(value);
  const rawTools = response?.tools;
  if (!Array.isArray(rawTools)) {
    throw new CuaDriverError("invalid_tools", "cua-driver returned an invalid tool catalog.");
  }
  if (response?.schema_version !== CUA_DRIVER_TOOL_SCHEMA) {
    throw new CuaDriverError(
      "incompatible_driver",
      `cua-driver tool schema ${String(response?.schema_version)} is unsupported.`,
    );
  }
  if (response?.capability_version !== CUA_DRIVER_CAPABILITY_VERSION) {
    throw new CuaDriverError(
      "incompatible_driver",
      `cua-driver capability schema ${String(response?.capability_version)} is unsupported.`,
    );
  }
  const tools = new Map<string, CuaDriverToolInfo>();
  for (const raw of rawTools) {
    const tool = asRecord(raw);
    if (!tool || typeof tool.name !== "string" || !tool.name) continue;
    // cua-driver exposes broader app/process/cursor powers. Even if the native
    // bridge accidentally returns one, it must never enter Aiden's catalog.
    if (!CUA_DRIVER_ALLOWED_TOOLS.has(tool.name)) continue;
    if (
      !Array.isArray(tool.capabilities) ||
      !tool.capabilities.every((item) => typeof item === "string")
    ) {
      throw new CuaDriverError(
        "invalid_tools",
        `cua-driver returned invalid capabilities for ${tool.name}.`,
      );
    }
    const capabilities = new Set(tool.capabilities as string[]);
    const inputSchema = tool.inputSchema ?? tool.input_schema;
    const annotations = asRecord(tool.annotations);
    const info: CuaDriverToolInfo = {
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : undefined,
      inputSchema,
      capabilities,
      readOnly:
        typeof tool.read_only === "boolean"
          ? tool.read_only
          : typeof tool.readOnly === "boolean"
            ? tool.readOnly
            : typeof annotations?.readOnlyHint === "boolean"
              ? annotations.readOnlyHint
              : undefined,
      destructive:
        typeof tool.destructive === "boolean"
          ? tool.destructive
          : typeof annotations?.destructiveHint === "boolean"
            ? annotations.destructiveHint
            : undefined,
      idempotent:
        typeof tool.idempotent === "boolean"
          ? tool.idempotent
          : typeof annotations?.idempotentHint === "boolean"
            ? annotations.idempotentHint
            : undefined,
      openWorld:
        typeof tool.open_world === "boolean"
          ? tool.open_world
          : typeof tool.openWorld === "boolean"
            ? tool.openWorld
            : typeof annotations?.openWorldHint === "boolean"
              ? annotations.openWorldHint
              : undefined,
    };
    // Validate every exposed schema during readiness, before any tool call can
    // reach the privileged bridge.
    cuaDriverToolDeclaresSession(info);
    tools.set(tool.name, info);
  }
  for (const required of CUA_DRIVER_REQUIRED_TOOLS) {
    if (!tools.has(required)) {
      throw new CuaDriverError(
        "incompatible_driver",
        `cua-driver is missing required tool ${required}.`,
      );
    }
  }
  return {
    tools,
    schemaVersion: response.schema_version,
    capabilityVersion: response.capability_version,
  };
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "AbortError" || /abort|cancel/i.test(error.message))
  );
}
