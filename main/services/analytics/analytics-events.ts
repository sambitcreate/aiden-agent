// The closed list of product-analytics events. Every property is an enum, a
// boolean, a bounded integer, a normalised id or a version string. Nothing
// outside this registry can be sent: the core drops unknown events and
// properties, and the client's before_send guard re-checks every payload.
// Renaming an event or a value breaks dashboards, so treat names as stable.

export type AnalyticsPropSpec =
  | { readonly kind: "enum"; readonly values: readonly string[]; readonly optional?: true }
  | { readonly kind: "boolean"; readonly optional?: true }
  | { readonly kind: "integer"; readonly min: number; readonly max: number; readonly optional?: true }
  | { readonly kind: "id"; readonly optional?: true }
  | { readonly kind: "version"; readonly optional?: true };

type PropsSpec = Readonly<Record<string, AnalyticsPropSpec>>;

function enumProp<const V extends readonly string[]>(...values: V) {
  return { kind: "enum", values } as const;
}

function optional<const S extends AnalyticsPropSpec>(spec: S) {
  return { ...spec, optional: true } as const;
}

const bool = { kind: "boolean" } as const;
const id = { kind: "id" } as const;
const version = { kind: "version" } as const;

export const COUNT_BUCKETS = ["0", "1", "2-3", "4-10", "11+"] as const;
export const UPTIME_BUCKETS = ["<1m", "1-10m", "10-60m", "1h+"] as const;

const RUN_TRIGGERS = enumProp("automatic", "manual", "catch_up", "retry", "file_change", "webhook");

export const ANALYTICS_EVENTS = {
  // Who's using it
  app_opened: { launch_kind: enumProp("cold", "after_update", "after_crash") },
  app_active: {},
  onboarding_finished: { outcome: enumProp("completed", "deferred"), provider_id: optional(id) },
  app_updated: { from_version: version, to_version: version },
  analytics_disabled: {},

  // Core use
  chat_message_sent: {
    provider_id: id,
    model_id: id,
    in_workspace: bool,
    thinking: enumProp("off", "minimal", "low", "medium", "high", "xhigh", "other"),
    origin: enumProp("desktop", "phone", "bot", "schedule"),
  },
  chat_created: { workspace_kind: enumProp("folder", "scratch", "worktree", "none") },
  provider_connected: { provider_id: id, auth: enumProp("key", "oauth", "local") },
  workspace_added: { kind: enumProp("folder", "scratch", "path") },

  // Big features
  bot_created: { preset_id: id, bot_count: enumProp(...COUNT_BUCKETS) },
  bot_routine_ran: { trigger: RUN_TRIGGERS, result: enumProp("success", "failed") },
  scheduled_task_ran: { trigger: RUN_TRIGGERS, result: enumProp("success", "silent", "failed") },
  subagent_launched: { role: enumProp("scout", "planner", "reviewer", "implementer", "other") },
  skill_used: { source: enumProp("builtin", "user"), skill_id: optional(id) },
  connector_added: { preset_id: id, transport: enumProp("stdio", "http") },
  web_search_used: { search_provider: id },
  voice_used: { mode: enumProp("live", "dictation", "read_aloud"), engine: enumProp("local", "cloud") },
  phone_paired: { transport: enumProp("lan", "tailscale"), device_count: enumProp(...COUNT_BUCKETS) },
  peer_mac_paired: { method: enumProp("discovery", "code", "link") },
  computer_use_enabled: {},
  bot_computer_set_up: { element_control: bool },
  terminal_opened: {},
  git_commit: { pushed: bool },
  worktree_created: {},

  // Crashes without a JavaScript stack (process gone, unclean exit)
  app_crashed: {
    kind: enumProp("renderer", "renderer_loop", "gpu", "utility", "unclean_exit", "other"),
    reason: optional(enumProp(
      "clean_exit",
      "abnormal_exit",
      "killed",
      "crashed",
      "oom",
      "launch_failed",
      "integrity_failure",
      "memory_eviction",
      "other",
    )),
    exit_code: optional({ kind: "integer", min: -2_147_483_648, max: 4_294_967_295 } as const),
  },
} as const satisfies Readonly<Record<string, PropsSpec>>;

// Properties carried by every $exception event, next to $exception_list.
export const EXCEPTION_PROPERTIES = {
  source: enumProp("main", "renderer", "cli"),
  level: enumProp("fatal", "error"),
  process_type: optional(enumProp("browser", "renderer", "utility", "cli")),
  origin: optional(enumProp("uncaught_exception", "unhandled_rejection", "window_error", "pending_crash")),
  uptime_bucket: optional(enumProp(...UPTIME_BUCKETS)),
} as const satisfies PropsSpec;

// Attached to every event and exception.
export const SUPER_PROPERTIES = {
  app_version: version,
  platform: enumProp("darwin", "linux", "win32", "other"),
  arch: enumProp("arm64", "x64", "other"),
  os_major: { kind: "integer", min: 0, max: 999 },
  surface: enumProp("desktop", "cli"),
  channel: enumProp("release", "beta", "dev"),
} as const satisfies PropsSpec;

export type AnalyticsEventName = keyof typeof ANALYTICS_EVENTS;

type PropValue<S> = S extends { kind: "enum"; values: readonly (infer V)[] }
  ? V
  : S extends { kind: "boolean" }
    ? boolean
    : S extends { kind: "integer" }
      ? number
      : string;

type RequiredKeys<P> = { [K in keyof P]: P[K] extends { optional: true } ? never : K }[keyof P];
type OptionalKeys<P> = Exclude<keyof P, RequiredKeys<P>>;

export type AnalyticsPropsFor<P> = { [K in RequiredKeys<P>]: PropValue<P[K]> } & {
  [K in OptionalKeys<P>]?: PropValue<P[K]>;
};

export type AnalyticsEventProps<E extends AnalyticsEventName> = AnalyticsPropsFor<(typeof ANALYTICS_EVENTS)[E]>;
export type AnalyticsExceptionProps = AnalyticsPropsFor<typeof EXCEPTION_PROPERTIES>;
export type AnalyticsSuperProperties = AnalyticsPropsFor<typeof SUPER_PROPERTIES>;

export const EXCEPTION_EVENT = "$exception";

const ID_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,79}$/u;
const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/u;

export function isAnalyticsEventName(value: string): value is AnalyticsEventName {
  return Object.prototype.hasOwnProperty.call(ANALYTICS_EVENTS, value);
}

export function isValidPropValue(spec: AnalyticsPropSpec, value: unknown): boolean {
  switch (spec.kind) {
    case "enum":
      return typeof value === "string" && spec.values.includes(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isSafeInteger(value) && (value as number) >= spec.min && (value as number) <= spec.max;
    case "id":
      return typeof value === "string" && ID_PATTERN.test(value);
    case "version":
      return typeof value === "string" && VERSION_PATTERN.test(value);
  }
}

// Keeps only the declared properties whose values pass their spec. Returns
// undefined when a required property is missing or invalid, so a call site
// bug drops the event instead of sending a half-filled one.
export function pickValidProps(
  specs: PropsSpec,
  props: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  const picked: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(specs)) {
    const value = props && Object.prototype.hasOwnProperty.call(props, key) ? props[key] : undefined;
    if (value === undefined) {
      if (spec.optional) continue;
      return undefined;
    }
    if (!isValidPropValue(spec, value)) {
      if (spec.optional) continue;
      return undefined;
    }
    picked[key] = value;
  }
  return picked;
}
