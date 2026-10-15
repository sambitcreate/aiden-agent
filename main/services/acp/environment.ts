import { agentCommandEnvironment } from "../agent-command-environment.js";

/**
 * Variables Aiden's own process carries that an external agent must never
 * inherit: Electron/Node switches that change how a child interprets itself,
 * and Aiden-internal state. Harness definitions add their own credential and
 * state keys on top.
 */
const ALWAYS_STRIPPED = [
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "ELECTRON_ENABLE_LOGGING",
  "NODE_OPTIONS",
  "NODE_CHANNEL_FD",
  "NODE_UNIQUE_ID",
] as const;

const ALWAYS_STRIPPED_PREFIXES = ["AIDEN_", "VSCODE_"] as const;

export interface ChildEnvironmentOptions {
  /** Exact names (case-insensitive) the harness must not inherit. */
  strip?: readonly string[];
  /** Values the harness requires; they win over inherited values. */
  set?: Readonly<Record<string, string>>;
}

/**
 * Build the environment for an ACP agent. Commands the agent runs natively see
 * the same PATH Aiden's own `run_command` uses, minus credentials and process
 * switches that would leak authority or change the child's runtime.
 */
export function buildChildEnvironment(
  options: ChildEnvironmentOptions = {},
  parent: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const inherited = agentCommandEnvironment(parent, platform);
  const stripped = new Set(
    [...ALWAYS_STRIPPED, ...(options.strip ?? [])].map((name) => name.toUpperCase()),
  );
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (stripped.has(upper)) continue;
    if (ALWAYS_STRIPPED_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue;
    env[name] = value;
  }
  for (const [name, value] of Object.entries(options.set ?? {})) env[name] = value;
  return env;
}
