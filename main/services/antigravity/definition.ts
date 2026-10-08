/**
 * Google Antigravity as an Aiden ACP harness.
 *
 * Launch environment, profile isolation and protocol quirks follow T3 Code
 * apps/server/src/provider/{antigravityAuthSupport,acp/AntigravityProtocol,
 * acp/AntigravityAcpSupport}.ts @ f870c419fc (MIT), re-checked against
 * Antigravity ACP 1.3.0 (docs/plans/antigravity-acp-spike.md).
 */
import type { RequestPermissionRequest, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";

import { buildChildEnvironment } from "../acp/environment.js";
import type { AcpHarnessDefinition, AcpHostPermission, AcpLaunchContext } from "../acp/harness.js";
import {
  ANTIGRAVITY_API,
  ANTIGRAVITY_PROVIDER_ID,
  fallbackAntigravityModels,
  modelChoicesFromConfig,
  nativeAntigravityModelId,
  projectNativeModels,
} from "./models.js";
import { ANTIGRAVITY_HARNESS_MEMBER, ANTIGRAVITY_RELEASE } from "./release.js";

export const ANTIGRAVITY_LABEL = "Google Antigravity";
export const ANTIGRAVITY_AGENT_NAME = "antigravity-acp";
export const ANTIGRAVITY_SIGN_IN_METHOD = "oauth-personal";
const QUESTION_PREFIX = "interaction_";
const SECURITY_WARNING_META = "agy.security.warning";

/** Ambient Google credentials and Antigravity state the agent must never inherit. */
export const ANTIGRAVITY_STRIPPED_ENV = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "AGY_ACP_FORCE_FILE_STORAGE",
  "ANTIGRAVITY_HARNESS_PATH",
  "GEMINI_HOME",
  "BROWSER",
  "PYTHONUNBUFFERED",
  "TMPDIR",
  "TEMP",
  "TMP",
] as const;

/** Directory Antigravity keeps its own credentials and settings in, under GEMINI_HOME. */
export function antigravityProfileDir(stateDir: string): string {
  return path.join(stateDir, "profile");
}

export function antigravitySettingsPath(stateDir: string): string {
  return path.join(antigravityProfileDir(stateDir), "antigravity-acp", "settings.json");
}

export function antigravityTokenPath(stateDir: string): string {
  return path.join(antigravityProfileDir(stateDir), "antigravity-acp", "acp_token.json");
}

/**
 * Chat and catalog launches need the auth type recorded in settings so the
 * server uses the saved token without an interactive `authenticate`.
 */
async function ensureSignedInSettings(stateDir: string): Promise<void> {
  const file = antigravitySettingsPath(stateDir);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
  } catch {
    // Missing or unreadable settings are rewritten below.
  }
  const auth = settings.auth && typeof settings.auth === "object" ? (settings.auth as Record<string, unknown>) : {};
  if (auth.type === ANTIGRAVITY_SIGN_IN_METHOD) return;
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({ ...settings, auth: { ...auth, type: ANTIGRAVITY_SIGN_IN_METHOD } }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await rename(temporary, file);
}

/** The Google authorization URL Antigravity printed, if this stderr line carries one. */
export function authorizationUrlFromStderr(line: string): string | undefined {
  const marker = line.indexOf(AUTH_URL_MARKER);
  const candidate = marker >= 0
    ? line.slice(marker + AUTH_URL_MARKER.length)
    : /Open the following link to authenticate[^:]*:\s*(\S+)/u.exec(line)?.[1];
  return candidate?.trim() || undefined;
}

/** Prefix the `BROWSER` hook writes before the URL Antigravity asked it to open. */
export const AUTH_URL_MARKER = "__AIDEN_ANTIGRAVITY_AUTH_URL__";

export interface AntigravityDefinitionOptions {
  /** Whether a saved Google sign-in exists; read at each launch. */
  hasSignIn(): Promise<boolean>;
}

export function createAntigravityDefinition(options: AntigravityDefinitionOptions): AcpHarnessDefinition {
  return {
    id: ANTIGRAVITY_PROVIDER_ID,
    label: ANTIGRAVITY_LABEL,
    api: ANTIGRAVITY_API,
    agentName: ANTIGRAVITY_AGENT_NAME,
    release: ANTIGRAVITY_RELEASE,
    fileSystem: true,
    validateInitialize(initialize, expectedVersion) {
      const info = initialize.agentInfo;
      if (info?.name !== ANTIGRAVITY_AGENT_NAME) return "The installed runtime is not Google Antigravity.";
      const version = (info.version ?? "").replace(/^agy_acp_server_/u, "");
      if (version !== expectedVersion) {
        return `The installed runtime is version ${version || "unknown"}, but Aiden expects ${expectedVersion}. Reinstall it in Settings.`;
      }
      if (initialize.protocolVersion !== 1) return "The installed runtime speaks an unsupported protocol version.";
      const capabilities = initialize.agentCapabilities;
      if (!capabilities?.sessionCapabilities?.resume && capabilities?.loadSession !== true) {
        return "The installed runtime cannot restore sessions.";
      }
      if (!(initialize.authMethods ?? []).some((method) => method.id === ANTIGRAVITY_SIGN_IN_METHOD)) {
        return "The installed runtime does not offer Google sign-in.";
      }
      return undefined;
    },
    async prepareLaunch(context: AcpLaunchContext) {
      const profile = antigravityProfileDir(context.stateDir);
      await mkdir(profile, { recursive: true, mode: 0o700 });
      if ((context.purpose === "chat" || context.purpose === "catalog") && (await options.hasSignIn())) {
        await ensureSignedInSettings(context.stateDir);
      }
      const env = buildChildEnvironment({
        strip: ANTIGRAVITY_STRIPPED_ENV,
        set: {
          GEMINI_HOME: profile,
          AGY_ACP_FORCE_FILE_STORAGE: "1",
          ANTIGRAVITY_HARNESS_PATH: path.join(context.runtimeDir, ANTIGRAVITY_HARNESS_MEMBER),
          PYTHONUNBUFFERED: "1",
          TMPDIR: context.tmpDir.endsWith(path.sep) ? context.tmpDir : `${context.tmpDir}${path.sep}`,
          TEMP: context.tmpDir,
          TMP: context.tmpDir,
          ...(context.browserHook ? { BROWSER: context.browserHook } : {}),
        },
      });
      return {
        command: path.join(context.runtimeDir, context.asset.executable),
        args: [...context.asset.args],
        env,
      };
    },
    nativeModeFor(permission: AcpHostPermission) {
      return permission === "full" ? "yolo" : "default";
    },
    fallbackModels: fallbackAntigravityModels,
    projectModels(configOptions) {
      const { configId, choices } = modelChoicesFromConfig(configOptions);
      return { models: projectNativeModels(choices), ...(configId ? { modelConfigId: configId } : {}) };
    },
    nativeModelId: nativeAntigravityModelId,
    classifyPermission: classifyAntigravityPermission,
    isSubagentCall: isAntigravitySubagentCall,
    hostInstructionsPreamble:
      "You are running inside Aiden, a desktop app. Your file reads and writes go through Aiden and are limited to this chat's folder. " +
      "Tools whose names start with `aiden_` are Aiden's own tools; use them for things your built-in tools cannot do. " +
      "The instructions below were written for Aiden's own tool names; use your equivalent tools.",
  };
}

/** Antigravity delivers fixed-choice questions as permission requests on `interaction_*` calls. */
export function classifyAntigravityPermission(request: RequestPermissionRequest) {
  const id = String(request.toolCall.toolCallId);
  if (id.startsWith(QUESTION_PREFIX)) {
    return {
      kind: "question" as const,
      question: {
        title: (request.toolCall.title ?? "").trim().slice(0, 400) || "Choose an option.",
        options: request.options.map((option) => ({ id: option.optionId, label: option.name.slice(0, 120) })),
      },
    };
  }
  let warning: string | undefined;
  for (const option of request.options) {
    const meta = option._meta?.[SECURITY_WARNING_META] as { title?: unknown; message?: unknown } | undefined;
    if (typeof meta?.message === "string" && meta.message.trim()) {
      warning = meta.message.trim().slice(0, 600);
      break;
    }
  }
  return { kind: "approval" as const, ...(warning ? { warning } : {}) };
}

export function isAntigravitySubagentCall(update: ToolCall | ToolCallUpdate): boolean {
  if (update._meta?.is_mcp_tool_call === true) return false;
  if (update.kind && update.kind !== "other") return false;
  const title = (update.title ?? "").trim();
  return title === "Running start_subagent" || title === "Run start_subagent?";
}
