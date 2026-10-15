/* global Buffer, structuredClone */

/**
 * The macOS tools/list surface of cua-driver-rs-v0.34.1, restricted to the
 * tools Aiden's broker allowlists, plus the driver's argument boundary and
 * result shapes. Shared by the stdio fake driver and the in-memory test
 * sessions so both reject exactly what the pinned driver rejects.
 *
 * Sources (all at tag cua-driver-rs-v0.34.1, libs/cua-driver/):
 * - input schemas: rust/crates/platform-macos/src/tools/*.rs `def()`, with the
 *   advertised `session` (closed schemas) and typed `target` added by
 *   cua-driver-core/src/tool.rs::advertised_runtime_input_schema; contract
 *   tools (verify_state, invoke_menu, set_window_frame, sessions) from
 *   contract/manifest.json. Descriptions are omitted.
 * - capabilities: cua-driver-core/src/tool.rs::default_capabilities_for plus
 *   the schema-derived `input.delivery_mode`.
 * - unknown arguments: tool.rs::unknown_argument -> protected_refusal
 *   `{status:"refused", refusal:{code:"invalid_arguments"}}`.
 * - action results: cua-driver-contract/src/outputs.rs::ActionResult.
 * - stale tokens / missing screenshot: cua-driver-core/src/snapshot_store.rs.
 */

const string = { type: "string" };
const integer = { type: "integer" };
const number = { type: "number" };
const boolean = { type: "boolean" };
const stringArray = { type: "array", items: string };
const deliveryMode = { type: "string", enum: ["background", "foreground"] };
const scope = { type: "string", enum: ["window", "desktop"] };
const button = { type: "string", enum: ["left", "right", "middle"] };
const elementTokenSchema = { type: "string", pattern: "^s[0-9a-f]{8}:[0-9]+$" };
const actionTarget = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { const: "window" },
        pid: { type: "integer", minimum: 1 },
        window_id: { type: "integer", minimum: 1 },
      },
      required: ["kind", "pid", "window_id"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { kind: { const: "desktop" }, display_id: { const: "primary" } },
      required: ["kind", "display_id"],
    },
  ],
};

function closed(properties, required = []) {
  return {
    type: "object",
    properties: { session: string, ...properties },
    required,
    additionalProperties: false,
  };
}

function open(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: true };
}

const READ_ONLY = new Set([
  "health_report",
  "list_apps",
  "list_windows",
  "get_window_state",
  "verify_state",
]);

export const ACTION_RESULT_TOOLS = new Set([
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "invoke_menu",
  "set_window_frame",
]);

export const TOOL_DEFINITIONS = {
  start_session: {
    inputSchema: open({
      session: string,
      capture_scope: { type: "string", enum: ["auto", "window", "desktop"] },
      cursor_motion: { type: ["object", "null"] },
      cursor_theme: { type: ["object", "null"] },
    }),
    capabilities: ["session.lifecycle.start", "session.capture_scope"],
  },
  end_session: {
    inputSchema: open({ session: string }),
    capabilities: ["session.lifecycle.end"],
  },
  health_report: {
    inputSchema: closed({ include: stringArray, skip: stringArray }),
    capabilities: [],
  },
  check_permissions: {
    inputSchema: closed({ prompt: boolean, probe_direct_capture: boolean }),
    capabilities: [
      "system.permissions.tcc",
      "system.permissions.tcc.accessibility",
      "system.permissions.tcc.screen_recording",
    ],
  },
  list_apps: { inputSchema: closed({}), capabilities: ["app.list"] },
  list_windows: {
    inputSchema: closed({ pid: integer, on_screen_only: boolean }),
    capabilities: ["window.list"],
  },
  get_window_state: {
    inputSchema: closed(
      {
        pid: integer,
        window_id: integer,
        query: string,
        capture_mode: { type: "string", enum: ["ax", "vision"] },
        include_accessibility_tree: boolean,
        include_screenshot: boolean,
        screenshot_out_file: string,
        max_elements: { type: "integer", minimum: 1 },
        max_depth: { type: "integer", minimum: 1 },
        timeout_ms: { type: "integer", minimum: 1 },
        max_dimension: { type: "integer", minimum: 1 },
        max_image_dimension: { type: "integer", minimum: 0 },
        display_only: boolean,
      },
      ["pid", "window_id"],
    ),
    capabilities: [
      "accessibility.window_state",
      "accessibility.tree",
      "accessibility.tree.structured",
      "accessibility.tree.bounded",
      "accessibility.element_tokens",
      "screen.capture",
      "screen.capture.window",
    ],
  },
  verify_state: {
    inputSchema: closed(
      {
        pid: { type: "integer", minimum: 1 },
        window_id: integer,
        expect: { type: "array", minItems: 1, maxItems: 8, items: { type: "object" } },
        include_screenshot: { type: ["boolean", "null"] },
        stable_samples: { type: "integer", minimum: 1, maximum: 5, default: 2 },
        timeout_ms: { type: "integer", minimum: 0, maximum: 10_000, default: 5_000 },
      },
      ["pid", "window_id", "expect"],
    ),
    capabilities: [
      "state.verify",
      "state.verify.window",
      "state.verify.element",
      "state.observe.visual_evidence",
    ],
  },
  bring_to_front: {
    inputSchema: closed({ pid: integer, window_id: integer }, ["pid"]),
    capabilities: ["window.activate"],
  },
  click: {
    inputSchema: closed({
      pid: integer,
      window_id: integer,
      element_token: elementTokenSchema,
      capture_id: string,
      x: number,
      y: number,
      action: string,
      button,
      count: integer,
      modifier: stringArray,
      from_zoom: boolean,
      debug_image_out: string,
      delivery_mode: deliveryMode,
      scope,
      target: actionTarget,
    }),
    capabilities: [
      "input.pointer.click",
      "input.pointer.click.left",
      "accessibility.element_tokens",
      "input.delivery_mode",
    ],
  },
  double_click: {
    inputSchema: closed(
      {
        pid: integer,
        x: number,
        y: number,
        window_id: integer,
        element_token: elementTokenSchema,
        delivery_mode: deliveryMode,
      },
      ["pid"],
    ),
    capabilities: [
      "input.pointer.click",
      "input.pointer.click.left",
      "input.pointer.click.double",
      "accessibility.element_tokens",
      "input.delivery_mode",
    ],
  },
  right_click: {
    inputSchema: closed(
      {
        pid: integer,
        element_token: elementTokenSchema,
        window_id: integer,
        x: number,
        y: number,
        modifier: stringArray,
        delivery_mode: deliveryMode,
      },
      ["pid"],
    ),
    capabilities: [
      "input.pointer.click",
      "input.pointer.click.right",
      "accessibility.element_tokens",
      "input.delivery_mode",
    ],
  },
  drag: {
    inputSchema: closed(
      {
        pid: integer,
        window_id: integer,
        from_x: number,
        from_y: number,
        to_x: number,
        to_y: number,
        duration_ms: { type: "integer", minimum: 0, maximum: 10_000 },
        steps: { type: "integer", minimum: 1, maximum: 200 },
        modifier: stringArray,
        button,
        from_zoom: boolean,
        scope,
        delivery_mode: deliveryMode,
        target: actionTarget,
      },
      ["from_x", "from_y", "to_x", "to_y"],
    ),
    capabilities: ["input.pointer.drag", "input.delivery_mode"],
  },
  scroll: {
    inputSchema: closed(
      {
        pid: integer,
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        by: { type: "string", enum: ["line", "page"] },
        amount: { type: "integer", minimum: 1, maximum: 50 },
        window_id: integer,
        element_token: elementTokenSchema,
        x: number,
        y: number,
        scope,
        delivery_mode: deliveryMode,
        target: actionTarget,
      },
      ["direction"],
    ),
    capabilities: ["input.pointer.scroll", "accessibility.element_tokens", "input.delivery_mode"],
  },
  type_text: {
    inputSchema: closed(
      {
        pid: integer,
        text: string,
        window_id: integer,
        element_token: elementTokenSchema,
        x: number,
        y: number,
        delay_ms: { type: "integer", minimum: 0, maximum: 200 },
        scope,
        delivery_mode: deliveryMode,
        target: actionTarget,
      },
      ["text"],
    ),
    capabilities: [
      "input.keyboard.type",
      "input.keyboard.type.terminal_safe",
      "accessibility.element_tokens",
      "input.delivery_mode",
    ],
  },
  press_key: {
    inputSchema: closed(
      {
        pid: integer,
        key: string,
        modifiers: stringArray,
        window_id: integer,
        element_token: elementTokenSchema,
        x: number,
        y: number,
        scope,
        delivery_mode: deliveryMode,
        target: actionTarget,
      },
      ["key"],
    ),
    capabilities: ["input.keyboard.press", "accessibility.element_tokens", "input.delivery_mode"],
  },
  hotkey: {
    inputSchema: closed(
      {
        pid: integer,
        keys: { type: "array", items: string, minItems: 2 },
        x: number,
        y: number,
        window_id: integer,
        element_token: elementTokenSchema,
        scope,
        delivery_mode: deliveryMode,
        target: actionTarget,
      },
      ["keys"],
    ),
    capabilities: ["input.keyboard.hotkey", "input.delivery_mode"],
  },
  set_value: {
    inputSchema: closed(
      { pid: integer, window_id: integer, element_token: elementTokenSchema, value: string },
      ["pid", "value"],
    ),
    capabilities: ["input.keyboard.type", "accessibility.element_tokens"],
  },
  invoke_menu: {
    inputSchema: closed(
      {
        pid: { type: "integer", minimum: 1 },
        window_id: { type: "integer", minimum: 1 },
        path: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          items: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
      ["pid", "window_id", "path"],
    ),
    capabilities: ["menu.path.invoke", "accessibility.menu.native"],
  },
  set_window_frame: {
    inputSchema: closed(
      {
        pid: { type: "integer", minimum: 1 },
        window_id: { type: "integer", minimum: 1 },
        x: number,
        y: number,
        width: { type: "number", minimum: 1 },
        height: { type: "number", minimum: 1 },
      },
      ["pid", "window_id", "x", "y", "width", "height"],
    ),
    capabilities: ["window.frame.set"],
  },
};

const ACTION_RESULT_OUTPUT_SCHEMA = {
  type: "object",
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        effect: {
          type: "string",
          enum: ["confirmed", "partial", "unverifiable", "suspected_noop", "refused"],
        },
        route: { type: "string" },
        delivery: { type: "object" },
        evidence: { type: "array" },
        escalation: { type: "object" },
        summary: string,
        error: { type: "object" },
      },
      required: ["effect", "route"],
    },
    {
      type: "object",
      additionalProperties: true,
      anyOf: [{ required: ["refusal"] }, { required: ["status"] }, { required: ["code"] }],
    },
  ],
};

/** tools/list entries in the 0.34.1 wire shape for the given tool names. */
export function toolListEntries(names) {
  return names.map((name) => {
    const definition = TOOL_DEFINITIONS[name];
    return {
      name,
      description: `Fake ${name}`,
      inputSchema: structuredClone(definition.inputSchema),
      annotations: {
        readOnlyHint: READ_ONLY.has(name),
        destructiveHint: !READ_ONLY.has(name) && name !== "check_permissions",
        idempotentHint: READ_ONLY.has(name),
        openWorldHint: false,
      },
      capabilities: [...definition.capabilities],
      risk: {
        class: READ_ONLY.has(name) ? "observe" : "act",
        enforcement: "reviewed",
        operation_sensitive: false,
        version: 1,
      },
      ...(ACTION_RESULT_TOOLS.has(name) ? { outputSchema: ACTION_RESULT_OUTPUT_SCHEMA } : {}),
    };
  });
}

/** The full 0.34.1 tools/list result for the given tool names. */
export function toolListResult(names) {
  return {
    tools: toolListEntries(names),
    capability_version: "1",
    schema_version: "1",
    enforcement_adapters: [{ id: "os_permission_prompt", state: "enforced" }],
  };
}

function refusalResult(code, message, extra = {}) {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { status: "refused", refusal: { code, message }, ...extra },
  };
}

/** A window-target refusal (`window_target.rs`, background_unavailable, ...). */
export function codedRefusal(code, message, extra = {}) {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { code, effect: "refused", ...extra },
  };
}

/**
 * The dispatch-boundary check: unknown arguments of a closed schema and
 * missing required arguments are refused before the platform tool runs.
 * Returns null when the arguments are admissible.
 */
export function argumentRefusal(name, args) {
  const definition = TOOL_DEFINITIONS[name];
  if (!definition) return refusalResult("unknown_tool", `Unknown tool: ${name}`);
  const schema = definition.inputSchema;
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(args).find((key) => !Object.hasOwn(schema.properties, key));
    if (unknown) {
      return refusalResult("invalid_arguments", `${name}: unknown argument ${unknown}`);
    }
  }
  const missing = schema.required.find((key) => !Object.hasOwn(args, key));
  if (missing) return refusalResult("invalid_arguments", `${name}: missing required ${missing}`);
  if (Object.hasOwn(args, "target")) {
    if (Object.hasOwn(args, "pid") || Object.hasOwn(args, "window_id") || Object.hasOwn(args, "scope")) {
      return codedRefusal(
        "invalid_action_target",
        "target cannot be combined with legacy scope, pid, or window_id fields",
      );
    }
    const target = args.target;
    if (
      target?.kind !== "window" ||
      !Number.isSafeInteger(target.pid) ||
      !Number.isSafeInteger(target.window_id) ||
      Object.keys(target).length !== 3
    ) {
      return codedRefusal("invalid_action_target", "window target accepts only kind, pid, and window_id");
    }
  }
  if (
    Object.hasOwn(args, "element_token") &&
    !new RegExp(schema.properties.element_token.pattern, "u").test(String(args.element_token))
  ) {
    return refusalResult("invalid_arguments", `${name}: element_token does not match the schema`);
  }
  return null;
}

/** Flat `{pid, window_id}` for an action call, from `target` or legacy fields. */
export function actionWindow(args) {
  if (args.target) return { pid: args.target.pid, windowId: args.target.window_id };
  return { pid: args.pid, windowId: args.window_id };
}

/** Successful closed ActionResult (`outputs.rs::ActionResult`). */
export function actionResult(name, overrides = {}) {
  const summary = overrides.summary ?? `${name} delivered`;
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: {
      effect: "unverifiable",
      route: "accessibility",
      delivery: { mode: "background" },
      ...overrides,
      summary,
    },
  };
}

/** `snapshot_store.rs::stale_token_refusal`. */
export function staleTokenRefusal(pid) {
  return refusalResult(
    "stale_element_token",
    `element_token is stale; call get_window_state again to refresh; pid ${pid} has no current snapshot`,
    { current_snapshots: [] },
  );
}

/** `snapshot_store.rs::screenshot_context_refusal`. */
export function screenshotContextRefusal(pid, windowId) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: "No current snapshot for this window contains a screenshot owned by this session. Call get_window_state with a screenshot on the same connection before using pixels.",
      },
    ],
    structuredContent: { code: "screenshot_context_missing", pid, window_id: windowId },
  };
}

export function elementToken(snapshotId, index) {
  return `s${snapshotId.toString(16).padStart(8, "0")}:${index}`;
}

/**
 * Per-window snapshot bookkeeping: each get_window_state of a window replaces
 * its previous snapshot, staling that snapshot's tokens, and records whether
 * the capture carried a screenshot for pixel actions.
 */
export class FakeSnapshotStore {
  nextId = 1;
  windows = new Map();

  publish(pid, windowId, withScreenshot) {
    const key = `${pid}:${windowId}`;
    const previous = this.windows.get(key);
    const id = this.nextId++;
    this.windows.set(key, { id, withScreenshot });
    return { id, invalidated: previous ? [`s${previous.id.toString(16).padStart(8, "0")}`] : [] };
  }

  /** Returns a refusal result, or null when the call may proceed. */
  admit(name, args) {
    const { pid, windowId } = actionWindow(args);
    // drag.rs refuses background delivery before resolving any coordinate.
    if (name === "drag" && args.delivery_mode !== "foreground") {
      return codedRefusal(
        "background_unavailable",
        "Background drag is unavailable on macOS: a drag is delivered as real pointer events to the frontmost window.",
        {
          suggestion: 'Retry this action with delivery_mode:"foreground".',
          escalation: { recommended: "foreground", reason: "background drag unavailable" },
        },
      );
    }
    if (typeof args.element_token === "string") {
      const [snapshot] = args.element_token.split(":");
      const live = [...this.windows.entries()].some(
        ([key, current]) =>
          key.startsWith(`${pid}:`) && `s${current.id.toString(16).padStart(8, "0")}` === snapshot,
      );
      if (!live) return staleTokenRefusal(pid);
      return null;
    }
    // set_window_frame's x/y are desktop points, not screenshot pixels.
    const pixels =
      name !== "set_window_frame" &&
      ["x", "from_x"].some((key) => typeof args[key] === "number");
    if (pixels) {
      const snapshot = this.windows.get(`${pid}:${windowId}`);
      if (!snapshot?.withScreenshot) return screenshotContextRefusal(pid, windowId);
    }
    if (name === "click" && Array.isArray(args.modifier) && args.modifier.length > 0) {
      if (args.delivery_mode !== "foreground" || windowId === undefined) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: 'click modifiers require delivery_mode:"foreground" and window_id on macOS',
            },
          ],
          // mcp_result.rs::conforming_error_envelope marks unstructured errors.
          structuredContent: { code: "tool_invocation_failed" },
        };
      }
    }
    return null;
  }
}

/** A PNG signature and IHDR prefix the controller can size without decoding. */
export function pngHeaderBase64(width, height) {
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header.toString("base64");
}

export const DEFAULT_WINDOWS = [
  {
    pid: 42,
    window_id: 7,
    app_name: "Safari",
    title: "Example",
    bounds: { x: 100, y: 50, width: 200, height: 100 },
    layer: 0,
    z_index: 9,
    is_on_screen: true,
  },
  {
    pid: 84,
    window_id: 8,
    app_name: "Hidden App",
    title: "Background",
    bounds: { x: 0, y: 0, width: 300, height: 200 },
    layer: 0,
    z_index: 1,
    is_on_screen: false,
  },
  {
    pid: 99,
    window_id: 9,
    app_name: "Finder",
    title: "Desktop",
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    layer: 0,
    z_index: 0,
    is_on_screen: true,
  },
];

export const DEFAULT_APPS = [
  { pid: 42, name: "Safari", bundle_id: "com.apple.Safari", running: true, active: true },
  { pid: 84, name: "Hidden App", bundle_id: "com.example.hidden", running: true, active: false },
  { pid: 99, name: "Finder", bundle_id: "com.apple.finder", running: true, active: false },
];

/** Default actionable AX rows; frames are screen points like `get_window_state.rs`. */
export const DEFAULT_ELEMENTS = [
  { role: "AXButton", label: "First", frame: { x: 110, y: 60, w: 20, h: 20 }, depth: 1 },
  { role: "AXButton", label: "Second", frame: { x: 250, y: 100, w: 20, h: 20 }, depth: 1 },
];

/**
 * Stateful 0.34.1 driver behaviour for Aiden's allowlisted tools: closed
 * argument schemas, per-window snapshot tokens that the next capture stales,
 * same-session screenshot context for pixels, background-drag refusal, and
 * the closed ActionResult on success.
 */
export class FakeCuaDriver {
  constructor({
    windows = DEFAULT_WINDOWS,
    apps = DEFAULT_APPS,
    elements = () => DEFAULT_ELEMENTS,
    screenshotScale = 2,
    hostBundleId = "com.sambitcreate.aiden-agent.cua-driver",
    permissions = { accessibility: true, screen_recording: true },
    actionOverrides = {},
  } = {}) {
    // Copied: set_window_frame mutates bounds, which must not leak between fakes.
    this.windows = structuredClone(windows);
    this.apps = apps;
    this.elements = elements;
    this.screenshotScale = screenshotScale;
    this.hostBundleId = hostBundleId;
    this.permissions = permissions;
    this.actionOverrides = actionOverrides;
    this.snapshots = new FakeSnapshotStore();
  }

  call(name, args = {}) {
    const refused = argumentRefusal(name, args);
    if (refused) return refused;
    switch (name) {
      case "start_session":
      case "end_session":
        return {
          content: [{ type: "text", text: `${name} ok` }],
          structuredContent: { session: args.session ?? "", active: name === "start_session" },
        };
      case "health_report":
        return this.healthReport(args);
      case "check_permissions":
        return this.checkPermissions();
      case "list_apps":
        return {
          content: [{ type: "text", text: `Found ${this.apps.length} apps.` }],
          structuredContent: { apps: this.apps },
        };
      case "list_windows": {
        const windows = this.windows.filter(
          (window) =>
            (args.pid === undefined || window.pid === args.pid) &&
            (args.on_screen_only !== true || window.is_on_screen),
        );
        return {
          content: [{ type: "text", text: `Found ${windows.length} windows.` }],
          structuredContent: { windows, current_space_id: 1 },
        };
      }
      case "get_window_state":
        return this.windowState(args);
      case "verify_state":
        return this.verifyState(args);
      case "bring_to_front":
        return {
          content: [{ type: "text", text: "Brought window to front." }],
          structuredContent: {
            status: "ok",
            code: "bring_to_front_exact_window_verified",
            pid: args.pid,
            window_id: args.window_id ?? null,
            activated: true,
          },
        };
      default:
        return this.action(name, args);
    }
  }

  healthReport(args) {
    const names = ["binary_version", "platform_supported", "session_active"];
    const include = Array.isArray(args.include) ? new Set(args.include) : null;
    return {
      content: [{ type: "text", text: "cua-driver 0.34.1 on darwin — ok" }],
      structuredContent: {
        schema_version: "1",
        platform: "darwin",
        driver_version: "0.34.1",
        overall: "ok",
        checks: names.map((check) =>
          include && !include.has(check)
            ? { name: check, status: "skip", message: "Skipped by include/skip filter." }
            : { name: check, status: "pass", message: `${check} ok` },
        ),
      },
    };
  }

  /** Embedded `check_permissions.rs`: never prompts, never runs the SCK probe. */
  checkPermissions() {
    return {
      content: [{ type: "text", text: "Permission status." }],
      structuredContent: {
        accessibility: this.permissions.accessibility,
        screen_recording: this.permissions.screen_recording,
        screen_recording_capturable: null,
        direct_capture_status: "not_checked",
        direct_capture_error: null,
        source: {
          attribution: "host",
          host_bundle_id: this.hostBundleId,
          embedded: true,
          direct_runtime: false,
          pid: 4242,
          responsible_ppid: 4241,
          executable: "/Applications/Aiden Agent.app/Contents/Helpers/cua-driver",
          disclaim_env: false,
          note: "Embedded mode.",
        },
      },
    };
  }

  windowState(args) {
    const window = this.windows.find((candidate) => candidate.window_id === args.window_id);
    if (!window) {
      return codedRefusal("window_id_not_found", `window_id ${args.window_id} was not found`);
    }
    if (window.pid !== args.pid) {
      return codedRefusal(
        "window_owner_pid_mismatch",
        `window_id ${args.window_id} is owned by pid ${window.pid}, not ${args.pid}`,
      );
    }
    const withTree = args.include_accessibility_tree !== false;
    const withScreenshot = args.include_screenshot !== false;
    if (!withTree && !withScreenshot) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "include_accessibility_tree:false and include_screenshot:false leave nothing to return",
          },
        ],
        structuredContent: { code: "invalid_arguments" },
      };
    }
    const { id, invalidated } = this.snapshots.publish(window.pid, window.window_id, withScreenshot);
    const width = Math.round(window.bounds.width * this.screenshotScale);
    const height = Math.round(window.bounds.height * this.screenshotScale);
    const rows = withTree ? this.elements(window).slice(0, args.max_elements ?? 2_000) : [];
    const elements = rows.map((row, index) => ({
      ...row,
      element_index: index,
      element_token: elementToken(id, index),
      ...(withScreenshot && row.frame
        ? {
            screenshot_frame: {
              x: Math.round((row.frame.x - window.bounds.x) * this.screenshotScale),
              y: Math.round((row.frame.y - window.bounds.y) * this.screenshotScale),
              w: Math.round(row.frame.w * this.screenshotScale),
              h: Math.round(row.frame.h * this.screenshotScale),
            },
          }
        : {}),
    }));
    const content = [];
    if (withScreenshot) {
      content.push({ type: "image", data: pngHeaderBase64(width, height), mimeType: "image/png" });
    }
    content.push({
      type: "text",
      text: `window_id=${window.window_id} pid=${window.pid} elements=${elements.length}`,
    });
    return {
      content,
      structuredContent: {
        window_id: window.window_id,
        pid: window.pid,
        element_count: elements.length,
        total_element_count: elements.length,
        returned_element_count: elements.length,
        elements_complete: false,
        tree_markdown: "",
        elements,
        snapshot_id: `s${id.toString(16).padStart(8, "0")}`,
        ...(invalidated.length ? { invalidated_snapshot_ids: invalidated } : {}),
        ...(withScreenshot
          ? {
              screenshot_width: width,
              screenshot_height: height,
              screenshot_mime_type: "image/png",
              window_bounds: window.bounds,
              screenshot_scale: this.screenshotScale,
              screenshot_frame_valid: true,
            }
          : {}),
        app_name: window.app_name,
        window_title: window.title,
      },
    };
  }

  /** `expectation.rs`: one sample, AND of predicates, absence never provable. */
  verifyState(args) {
    const window = this.windows.find(
      (candidate) => candidate.pid === args.pid && candidate.window_id === args.window_id,
    );
    for (const [index, predicate] of args.expect.entries()) {
      if (predicate.element?.exists === false) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `verify_state predicate ${index} element.exists=false is unsupported because element snapshots are not exhaustive`,
            },
          ],
          structuredContent: { code: "tool_invocation_failed" },
        };
      }
    }
    const predicates = args.expect.map((predicate, index) => {
      const outcome = (status, unknownReason = null, observed = null) => ({
        index,
        status,
        unknown_reason: unknownReason,
        observed_json: observed === null ? null : JSON.stringify(observed),
      });
      if (predicate.window && !predicate.element) {
        const exists = Boolean(window);
        if (predicate.window.exists !== undefined && predicate.window.exists !== exists) {
          return outcome("unsatisfied", null, { exists });
        }
        const expected = predicate.window.bounds;
        if (expected) {
          if (!window) return outcome("unsatisfied", null, { exists });
          const tolerance = expected.tolerance_px ?? 0;
          const matches = ["x", "y", "width", "height"].every(
            (key) => Math.abs(window.bounds[key] - expected[key]) <= tolerance,
          );
          return outcome(matches ? "satisfied" : "unsatisfied", null, { bounds: window.bounds });
        }
        return outcome("satisfied", null, { exists });
      }
      if (predicate.element && !predicate.window) {
        if (!window) return outcome("unknown", "target_missing", { window_exists: false });
        const { selector, value_equals: valueEquals, enabled, selected } = predicate.element;
        if (!selector?.role && !selector?.label_contains) return outcome("unknown", "invalid_predicate");
        const rows = this.elements(window);
        if (rows.some((row) => row.in_web_content)) return outcome("unknown", "untrusted_source");
        const matches = rows.filter(
          (row) =>
            (!selector.role || row.role === selector.role) &&
            (!selector.label_contains ||
              String(row.label ?? "").toLowerCase().includes(selector.label_contains.toLowerCase())),
        );
        if (matches.length === 0) return outcome("unknown", "observation_unavailable");
        if (matches.length > 1) return outcome("unknown", "multi_match");
        const [row] = matches;
        const holds =
          (valueEquals === undefined || row.value === valueEquals) &&
          (enabled === undefined || row.enabled === enabled) &&
          (selected === undefined || row.selected === selected);
        return outcome(holds ? "satisfied" : "unsatisfied", null, {
          role: row.role,
          label: row.label,
          value: row.value ?? null,
        });
      }
      return outcome("unknown", "invalid_predicate");
    });
    const statuses = predicates.map((predicate) => predicate.status);
    const status = statuses.includes("unsatisfied")
      ? "unsatisfied"
      : statuses.includes("unknown")
        ? "unknown"
        : "satisfied";
    const content = [{ type: "text", text: `verify_state: ${status} after 1 sample(s) in 0 ms` }];
    if (args.include_screenshot === true && window) {
      content.push({
        type: "image",
        data: pngHeaderBase64(
          Math.round(window.bounds.width * this.screenshotScale),
          Math.round(window.bounds.height * this.screenshotScale),
        ),
        mimeType: "image/png",
      });
    }
    return {
      content,
      structuredContent: {
        status,
        stable: status === "satisfied",
        elapsed_ms: 0,
        samples: 1,
        predicates,
      },
    };
  }

  action(name, args) {
    const { pid, windowId } = actionWindow(args);
    if (windowId === undefined && typeof args.element_token !== "string") {
      const candidates = this.windows.filter((window) => window.pid === pid);
      if (candidates.length === 0) {
        return codedRefusal("window_target_not_found", `pid ${pid} has no eligible window`, {
          pid,
          candidates: [],
        });
      }
      if (candidates.length > 1) {
        return codedRefusal(
          "ambiguous_window_target",
          `pid ${pid} owns ${candidates.length} windows; pass window_id`,
          {
            pid,
            candidates: candidates.map((window) => ({
              window_id: window.window_id,
              title: window.title,
              app_name: window.app_name,
              is_on_screen: window.is_on_screen,
            })),
          },
        );
      }
    }
    const refused = this.snapshots.admit(name, args);
    if (refused) return refused;
    const override = this.actionOverrides[name];
    if (override) return typeof override === "function" ? override(args) : override;
    if (name === "set_window_frame") {
      // set_window_frame.rs verifies the frame through an independent readback.
      const window = this.windows.find((candidate) => candidate.window_id === windowId);
      if (!window || window.pid !== pid) {
        return codedRefusal("window_id_not_found", `window_id ${windowId} was not found`);
      }
      window.bounds = { x: args.x, y: args.y, width: args.width, height: args.height };
      return actionResult(name, {
        effect: "confirmed",
        route: "accessibility",
        delivery: { mode: "not_applicable" },
        evidence: [{ kind: "value_readback", detail: "frame read back" }],
      });
    }
    if (name === "invoke_menu") {
      return actionResult(name, {
        effect: "unverifiable",
        route: "accessibility",
        delivery: { mode: "foreground" },
        summary: `Invoked menu ${args.path.join(" > ")}`,
      });
    }
    return actionResult(name, {
      route: typeof args.element_token === "string" ? "accessibility" : "synthetic_events",
      delivery: { mode: args.delivery_mode === "foreground" ? "foreground" : "background" },
    });
  }
}
