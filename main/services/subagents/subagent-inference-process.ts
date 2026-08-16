import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { UtilityProcess } from "electron";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  Models,
  ModelsSimpleStreamOptions,
  ProviderHeaders,
} from "@earendil-works/pi-ai";
import {
  createAssistantMessageEventStream,
  lazyStream,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { OPENAI_CODEX_PROVIDER_ID } from "../codex-provider.js";
import { writeDevLog } from "../dev-log.js";
import type { ResolvedModelRuntime } from "../model-runtime-core.js";
import { piRuntimePrivateFailure, type PiRuntimePrivateFailure } from "../pi-runtime-failure.js";
import {
  type KillableInferenceProcess,
  SubagentInferenceProcessOwner,
} from "./subagent-inference-process-core.js";
import {
  SUBAGENT_INFERENCE_PROTOCOL_VERSION,
  type SerializableStreamOptions,
} from "./subagent-inference-protocol.js";
import {
  isRetryableSubagentStartupFailure,
  SUBAGENT_STARTUP_RETRY_DELAYS_MS,
  waitForSubagentStartupRetry,
} from "./subagent-startup-retry.js";

function mergeHeaders(
  base: ProviderHeaders | undefined,
  override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
  if (!base && !override) return undefined;
  return { ...(base ?? {}), ...(override ?? {}) };
}

function closedInferenceError(model: Model<Api>, reason: "error" | "aborted"): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: reason,
    errorMessage:
      reason === "aborted"
        ? "The isolated provider request was cancelled."
        : "The isolated provider request failed.",
    timestamp: Date.now(),
  };
}

export function withZeroActivityStartupRetry(
  model: Model<Api>,
  createAttempt: () => AssistantMessageEventStream,
  signal: AbortSignal | undefined,
  enabled: boolean,
  retryDelays: readonly number[] = SUBAGENT_STARTUP_RETRY_DELAYS_MS,
  onPrivateFailure?: (failure: PiRuntimePrivateFailure) => void,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void (async () => {
    for (let attempt = 0; ; attempt += 1) {
      let observedModelActivity = false;
      let retry = false;
      let sawTerminal = false;
      for await (const event of createAttempt()) {
        if (event.type === "done" || event.type === "error") {
          sawTerminal = true;
          retry =
            enabled &&
            event.type === "error" &&
            attempt < retryDelays.length &&
            isRetryableSubagentStartupFailure({
              message: event.error,
              observedModelActivity,
            });
          if (!retry) {
            if (event.type === "error") {
              const privateFailure = piRuntimePrivateFailure(event.error);
              if (privateFailure) onPrivateFailure?.(privateFailure);
            }
            output.push(event);
            return;
          }
          break;
        }
        observedModelActivity = true;
        output.push(event);
      }
      if (!retry) {
        if (!sawTerminal) {
          const reason = signal?.aborted ? "aborted" : "error";
          const error = closedInferenceError(model, reason);
          output.push({ type: "error", reason, error });
        }
        return;
      }
      const delayMs = retryDelays[attempt] ?? 0;
      if (!(await waitForSubagentStartupRetry(delayMs, signal))) {
        const error = closedInferenceError(model, "aborted");
        output.push({ type: "error", reason: "aborted", error });
        return;
      }
    }
  })().catch(() => {
    const reason = signal?.aborted ? "aborted" : "error";
    const error = closedInferenceError(model, reason);
    output.push({ type: "error", reason, error });
  });
  return output;
}

class ElectronInferenceProcess implements KillableInferenceProcess {
  private exited: boolean;
  private launchIdentity: string | undefined;
  private launchError: Error | undefined;

  constructor(
    private readonly child: UtilityProcess,
    launchIdentity: string | undefined,
    private readonly expectedIdentityToken: string,
    launchError?: Error,
    initiallyExited = false,
  ) {
    this.exited = initiallyExited;
    this.launchIdentity = launchIdentity;
    this.launchError = launchError;
    child.once("spawn", () => {
      const identity = readOwnedProcessIdentity(child.pid);
      if (identity.kind === "found" && identity.identity.includes(this.expectedIdentityToken)) {
        this.launchIdentity = identity.identity;
      }
    });
    child.once("exit", () => {
      this.exited = true;
    });
  }

  setLaunchError(error: Error): void {
    this.launchError = error;
  }

  captureLaunchIdentity(): boolean {
    if (this.launchIdentity) return true;
    const identity = readOwnedProcessIdentity(this.child.pid);
    if (identity.kind !== "found" || !identity.identity.includes(this.expectedIdentityToken)) {
      return false;
    }
    this.launchIdentity = identity.identity;
    return true;
  }

  isLaunchVerified(): boolean {
    return this.launchError === undefined && this.captureLaunchIdentity();
  }

  postMessage(message: unknown): void {
    if (this.launchError) throw this.launchError;
    this.child.postMessage(message);
  }

  terminate(): boolean {
    return this.child.kill();
  }

  killHard(): void {
    const pid = this.child.pid;
    if (this.exited) return;
    if (!this.launchIdentity) {
      throw new Error("The isolated inference process launch identity is unavailable.");
    }
    const current = readOwnedProcessIdentity(pid);
    if (
      current.kind === "missing" ||
      (current.kind === "found" && current.identity !== this.launchIdentity)
    ) {
      return;
    }
    if (current.kind === "indeterminate") {
      throw new Error("Could not verify the isolated inference process identity before SIGKILL.");
    }
    if (typeof pid !== "number") {
      throw new Error("The isolated inference process PID is unavailable.");
    }
    process.kill(pid, "SIGKILL");
  }

  hasExited(): boolean {
    if (this.exited) return true;
    const current = readOwnedProcessIdentity(this.child.pid);
    if (current.kind === "missing") return true;
    if (current.kind === "indeterminate") {
      throw new Error("Could not verify isolated inference process termination.");
    }
    if (!this.launchIdentity) {
      throw new Error("The isolated inference process launch identity is unavailable.");
    }
    return current.identity !== this.launchIdentity;
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.child.on("message", listener);
    return () => this.child.off("message", listener);
  }

  onExit(listener: (code: number | null) => void): () => void {
    this.child.on("exit", listener);
    return () => this.child.off("exit", listener);
  }

  onError(listener: (error: Error) => void): () => void {
    const handler = (type: "FatalError", location: string) =>
      listener(new Error(`Subagent inference process ${type} at ${location}.`));
    this.child.on("error", handler);
    return () => this.child.off("error", handler);
  }
}

type OwnedProcessIdentityResult =
  | { kind: "found"; identity: string }
  | { kind: "missing" }
  | { kind: "indeterminate" };

function readOwnedProcessIdentity(pid: number | undefined): OwnedProcessIdentityResult {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) {
    return { kind: "indeterminate" };
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
      return { kind: "missing" };
    }
  }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return { kind: "indeterminate" };
  }
  try {
    const identity = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 16 * 1024,
    }).trim();
    return identity ? { kind: "found", identity } : { kind: "indeterminate" };
  } catch {
    return { kind: "indeterminate" };
  }
}

async function launchElectronInferenceProcess(
  request: import("./subagent-inference-protocol.js").SubagentInferenceStartMessage,
  signal?: AbortSignal,
): Promise<KillableInferenceProcess> {
  const { utilityProcess } = await import("electron");
  const entry = fileURLToPath(new URL("./subagent-inference-worker.js", import.meta.url));
  // The nonce is non-secret and makes the OS command identity unique even if
  // PID reuse occurs within ps(1)'s one-second start-time resolution.
  const launchNonce = randomUUID();
  const child = utilityProcess.fork(entry, [`--aiden-inference-owner=${launchNonce}`], {
    serviceName: "Aiden Subagent Inference",
    stdio: "ignore",
    env: {
      NODE_ENV: process.env.NODE_ENV ?? "production",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      TZ: process.env.TZ ?? "UTC",
      ...(request.options.env ?? {}),
    },
  });
  const initialIdentity = readOwnedProcessIdentity(child.pid);
  const owned = new ElectronInferenceProcess(
    child,
    initialIdentity.kind === "found" && initialIdentity.identity.includes(launchNonce)
      ? initialIdentity.identity
      : undefined,
    launchNonce,
  );
  return new Promise<KillableInferenceProcess>((resolve) => {
    let settled = false;
    let identityRetry: NodeJS.Timeout | undefined;
    const finish = (launchError?: Error, initiallyExited = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (launchError) owned.setLaunchError(launchError);
      if (launchError && !initiallyExited) child.kill();
      resolve(owned);
    };
    const verifySpawnIdentity = (attempt = 0) => {
      if (settled) return;
      if (owned.captureLaunchIdentity()) {
        finish();
        return;
      }
      if (attempt >= 9) {
        finish(new Error("Subagent inference process launch identity could not be verified."));
        return;
      }
      identityRetry = setTimeout(() => verifySpawnIdentity(attempt + 1), 25);
    };
    const onSpawn = () => verifySpawnIdentity();
    const onExit = (code: number) => {
      finish(new Error(`Subagent inference process exited during launch (${code}).`), true);
    };
    const onError = (type: "FatalError", location: string) => {
      finish(new Error(`Subagent inference process ${type} at ${location}.`));
    };
    const onAbort = () => finish(new Error("Subagent inference process launch cancelled."));
    const timeout = setTimeout(
      () => finish(new Error("Subagent inference process launch timed out.")),
      5_000,
    );
    const cleanup = () => {
      clearTimeout(timeout);
      if (identityRetry) clearTimeout(identityRetry);
      child.off("spawn", onSpawn);
      child.off("exit", onExit);
      child.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    child.on("spawn", onSpawn);
    child.on("exit", onExit);
    child.on("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function ambientProviderEnv(
  providerId: string,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const names =
    providerId === "amazon-bedrock"
      ? [
          "HOME",
          "AWS_ACCESS_KEY_ID",
          "AWS_BEARER_TOKEN_BEDROCK",
          "AWS_BEDROCK_FORCE_CACHE",
          "AWS_BEDROCK_FORCE_HTTP1",
          "AWS_BEDROCK_SKIP_AUTH",
          "AWS_SECRET_ACCESS_KEY",
          "AWS_SESSION_TOKEN",
          "AWS_PROFILE",
          "AWS_REGION",
          "AWS_DEFAULT_REGION",
          "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
          "AWS_CONTAINER_CREDENTIALS_FULL_URI",
          "AWS_CONTAINER_AUTHORIZATION_TOKEN",
          "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
          "AWS_WEB_IDENTITY_TOKEN_FILE",
          "AWS_ROLE_ARN",
          "AWS_ROLE_SESSION_NAME",
          "AWS_CONFIG_FILE",
          "AWS_SHARED_CREDENTIALS_FILE",
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "ALL_PROXY",
          "NO_PROXY",
          "http_proxy",
          "https_proxy",
          "all_proxy",
          "no_proxy",
        ]
      : providerId === "azure-openai-responses"
        ? [
            "AZURE_OPENAI_BASE_URL",
            "AZURE_OPENAI_RESOURCE_NAME",
            "AZURE_OPENAI_API_VERSION",
            "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
          ]
        : providerId === "google-vertex"
          ? [
              "HOME",
              "GOOGLE_APPLICATION_CREDENTIALS",
              "GOOGLE_CLOUD_PROJECT",
              "GCLOUD_PROJECT",
              "GOOGLE_CLOUD_LOCATION",
            ]
          : providerId === "cloudflare-workers-ai" || providerId === "cloudflare-ai-gateway"
            ? ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"]
            : [];
  names.push("PI_CACHE_RETENTION");
  return Object.fromEntries(
    names.flatMap((name) => (source[name] ? [[name, source[name] as string]] : [])),
  );
}

export interface SubagentInferenceIsolation {
  wrap(runtime: ResolvedModelRuntime): ResolvedModelRuntime;
  shutdown(): Promise<boolean>;
}

/**
 * Keeps Pi's Agent, session, tools, approvals, and MCP authority in main. Only
 * the provider request is delegated to a one-request Electron utility process.
 */
export class ElectronSubagentInferenceIsolation implements SubagentInferenceIsolation {
  private readonly shutdownController = new AbortController();
  private readonly owner = new SubagentInferenceProcessOwner(
    launchElectronInferenceProcess,
    undefined,
    (error) => {
      writeDevLog("error", "subagents", [
        "Could not verify isolated subagent inference process cleanup.",
        error,
      ]);
    },
  );

  wrap(runtime: ResolvedModelRuntime): ResolvedModelRuntime {
    let firstIsolatedRequest = true;
    let pendingHostFailure: "inference" | "policy" | undefined;
    const isolatedStreamSimple = (
      model: Model<Api>,
      context: Context,
      options?: ModelsSimpleStreamOptions,
    ) => {
      pendingHostFailure = undefined;
      const startupRetryEnabled = firstIsolatedRequest;
      firstIsolatedRequest = false;
      return lazyStream(model, async () => {
        let requestModel: Model<Api>;
        let requestOptions: ModelsSimpleStreamOptions;
        let leaseSignal: AbortSignal | undefined;
        let observeResult:
          | ((message: AssistantMessage, metadata?: { authenticationFailure?: boolean }) => void)
          | undefined;
        if (model.provider === OPENAI_CODEX_PROVIDER_ID) {
          if (!runtime.prepareIsolatedStream) {
            throw new Error("OpenAI Codex isolated dispatch is unavailable.");
          }
          const lease = await runtime.prepareIsolatedStream(model, options);
          requestModel = lease.model;
          const allowedEnv = ambientProviderEnv(
            model.provider,
            lease.options.env,
          );
          requestOptions = {
            ...lease.options,
            env: Object.keys(allowedEnv).length > 0 ? allowedEnv : undefined,
          };
          leaseSignal = lease.signal;
          observeResult = lease.observeResult;
        } else {
          const resolution = await runtime.models.getAuth(model, {
            apiKey: options?.apiKey ?? runtime.apiKey,
            env: options?.env,
          });
          if (!resolution) throw new Error(`Provider is not configured: ${model.provider}`);
          const apiKey = options?.apiKey ?? resolution.auth.apiKey;
          let headers = mergeHeaders(resolution.auth.headers ?? runtime.headers, options?.headers);
          if (options?.transformHeaders) headers = await options.transformHeaders(headers ?? {});
          requestModel = resolution.auth.baseUrl
            ? { ...model, baseUrl: resolution.auth.baseUrl }
            : model;
          // Only reviewed provider configuration crosses the worker boundary.
          // The worker bootstrap disables every child_process entry point, so
          // static/role/SSO profiles can resolve but credential_process cannot
          // escape the owned UtilityProcess.
          const envSource = {
            ...process.env,
            ...(resolution.env ?? {}),
            ...(options?.env ?? {}),
          };
          const allowedEnv = ambientProviderEnv(model.provider, envSource);
          const env = Object.keys(allowedEnv).length > 0 ? allowedEnv : undefined;
          requestOptions = { ...options, apiKey, headers, env };
        }
        const {
          signal,
          onPayload: _onPayload,
          onResponse: _onResponse,
          transformHeaders: _transformHeaders,
          ...serializable
        } = requestOptions;
        const prepared: SerializableStreamOptions = {
          ...serializable,
        };
        const requestSignals = [leaseSignal, signal, this.shutdownController.signal].filter(
          (candidate): candidate is AbortSignal => candidate !== undefined,
        );
        const requestSignal =
          requestSignals.length > 1 ? AbortSignal.any(requestSignals) : requestSignals[0];
        return withZeroActivityStartupRetry(
          requestModel,
          () =>
            this.owner.stream(
              {
                kind: "start",
                version: SUBAGENT_INFERENCE_PROTOCOL_VERSION,
                requestId: randomUUID(),
                model: requestModel,
                context,
                options: prepared,
              },
              {
                model: requestModel,
                onPayload: requestOptions.onPayload,
                onResponse: requestOptions.onResponse,
                onTerminal: (message, metadata) => observeResult?.(message, metadata),
              },
              requestSignal,
            ),
          requestSignal,
          startupRetryEnabled,
          SUBAGENT_STARTUP_RETRY_DELAYS_MS,
          (failure) => {
            pendingHostFailure = failure === "policy" ? "policy" : "inference";
          },
        );
      });
    };

    const models = new Proxy(runtime.models, {
      get(target, property, receiver) {
        if (property === "streamSimple") return isolatedStreamSimple;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Models;
    return {
      ...runtime,
      models,
      streams: { streamSimple: isolatedStreamSimple },
      consumeIsolatedHostFailure: () => {
        const failure = pendingHostFailure;
        pendingHostFailure = undefined;
        return failure;
      },
    };
  }

  shutdown(): Promise<boolean> {
    this.shutdownController.abort(new Error("Subagent inference isolation is shutting down."));
    return this.owner.shutdown();
  }
}
