/**
 * The contract an ACP agent implements to become an Aiden provider.
 *
 * Everything agent-specific lives behind this interface: the pinned release,
 * how to launch it, which native modes match Aiden's workspace permissions,
 * how its model catalog projects into Pi models, and protocol quirks. The
 * shared runtime (process supervision, file I/O, approvals, the tool bridge,
 * activity, sessions) is harness-agnostic, so adding another ACP agent means
 * writing one definition plus its sign-in flow.
 */
import type {
  InitializeResponse,
  RequestPermissionRequest,
  SessionConfigOption,
  ToolCall,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";

export type AcpPlatformKey = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";

export interface AcpReleaseMember {
  name: string;
  bytes: number;
}

export interface AcpPlatformAsset {
  /** Exact HTTPS download URL. */
  url: string;
  sha256: string;
  archiveBytes: number;
  /** The archive must contain exactly these regular files. */
  members: readonly AcpReleaseMember[];
  /** Member name that is launched. */
  executable: string;
  args: readonly string[];
}

export interface AcpRelease {
  version: string;
  platforms: Partial<Record<AcpPlatformKey, AcpPlatformAsset>>;
}

/**
 * Aiden's effective authority for one generation: the workspace permission,
 * narrowed to read-only when the chat was opened that way.
 */
export type AcpHostPermission = "full" | "ask" | "read-only" | "none";

export type AcpLaunchPurpose = "chat" | "validate" | "auth" | "catalog";

export interface AcpLaunchContext {
  /** Directory holding the verified release members. */
  runtimeDir: string;
  asset: AcpPlatformAsset;
  /** Private, harness-owned state directory (credentials, settings). */
  stateDir: string;
  /** Per-process temporary directory, removed when the process ends. */
  tmpDir: string;
  cwd: string;
  purpose: AcpLaunchPurpose;
  /** Executable the harness may point a `BROWSER`-style hook at. */
  browserHook?: string;
}

export interface AcpLaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AcpQuestion {
  title: string;
  options: Array<{ id: string; label: string }>;
}

export type AcpPermissionClassification =
  | { kind: "approval"; warning?: string }
  | { kind: "question"; question: AcpQuestion };

export interface AcpModelProjection {
  models: Model<Api>[];
  /** Config option id that selects the model, when the agent exposes one. */
  modelConfigId?: string;
}

export interface AcpHarnessDefinition {
  /** Provider id used everywhere in Aiden (`antigravity`). */
  id: string;
  label: string;
  /** Who builds and ships the agent runtime ("Google"), named in setup copy. */
  publisher: string;
  /** Pi API id for this harness's models. */
  api: Api;
  /** Expected `agentInfo.name` reported by `initialize`. */
  agentName: string;
  release: AcpRelease;
  /** Advertise ACP fs callbacks so the agent's file tools go through Aiden. */
  fileSystem: boolean;
  /** Validate a fresh install or launch; return a reason to refuse, or undefined. */
  validateInitialize(initialize: InitializeResponse, expectedVersion: string): string | undefined;
  /** Prepare private state and return the exact command line. */
  prepareLaunch(context: AcpLaunchContext): Promise<AcpLaunchSpec>;
  /** Native session mode for Aiden's permission, applied before each turn. */
  nativeModeFor(permission: AcpHostPermission): string | undefined;
  /** Conservative catalog shown before the first authenticated discovery. */
  fallbackModels(): Model<Api>[];
  /** Project an authenticated session's config options into Pi models. */
  projectModels(options: readonly SessionConfigOption[]): AcpModelProjection;
  /** The agent's own model id for Aiden's model and reasoning level. */
  nativeModelId(model: Model<Api>, reasoning: ThinkingLevel | undefined): string;
  /** Distinguish real approvals from agent questions delivered as permission requests. */
  classifyPermission?(request: RequestPermissionRequest): AcpPermissionClassification;
  /** Reclassify a tool call (for example, subagent batches). */
  isSubagentCall?(update: ToolCall | ToolCallUpdate): boolean;
  /**
   * True when a stderr line shows the agent asking for an interactive
   * sign-in. During a chat that means the saved sign-in no longer works.
   */
  detectSignInPrompt?(line: string): boolean;
  /** Stdout lines that are known noise; they are dropped either way. */
  observeStdoutNoise?(line: string): void;
  /** Extra short instructions prepended to Aiden's system prompt for this agent. */
  hostInstructionsPreamble?: string;
}

export function currentPlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): AcpPlatformKey | undefined {
  if (platform !== "darwin" && platform !== "linux") return undefined;
  if (arch !== "arm64" && arch !== "x64") return undefined;
  return `${platform}-${arch}` as AcpPlatformKey;
}
