import { randomUUID } from "node:crypto";
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
import { lazyStream } from "@earendil-works/pi-ai";
import { OPENAI_CODEX_PROVIDER_ID } from "../codex-provider.js";
import { writeDevLog } from "../dev-log.js";
import type { ResolvedModelRuntime } from "../model-runtime-core.js";
import {
  type KillableInferenceProcess,
  SubagentInferenceProcessOwner,
} from "./subagent-inference-process-core.js";
import {
  SUBAGENT_INFERENCE_PROTOCOL_VERSION,
  type SerializableStreamOptions,
} from "./subagent-inference-protocol.js";

function mergeHeaders(
  base: ProviderHeaders | undefined,
  override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
  if (!base && !override) return undefined;
  return { ...(base ?? {}), ...(override ?? {}) };
}

class ElectronInferenceProcess implements KillableInferenceProcess {
  constructor(private readonly child: UtilityProcess) {}

  get pid(): number | undefined {
    return this.child.pid;
  }

  postMessage(message: unknown): void {
    this.child.postMessage(message);
  }

  terminate(): boolean {
    return this.child.kill();
  }

  killHard(pid: number): void {
    process.kill(pid, "SIGKILL");
  }

  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return !(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      );
    }
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

async function launchElectronInferenceProcess(
  request: import("./subagent-inference-protocol.js").SubagentInferenceStartMessage,
): Promise<KillableInferenceProcess> {
  const { utilityProcess } = await import("electron");
  const entry = fileURLToPath(new URL("./subagent-inference-worker.js", import.meta.url));
  const child = utilityProcess.fork(entry, [], {
    serviceName: "Aiden Subagent Inference",
    stdio: "ignore",
    env: {
      NODE_ENV: process.env.NODE_ENV ?? "production",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      TZ: process.env.TZ ?? "UTC",
      ...(request.options.env ?? {}),
    },
  });
  await new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`Subagent inference process exited during launch (${code}).`));
    };
    const onError = (type: "FatalError", location: string) => {
      cleanup();
      reject(new Error(`Subagent inference process ${type} at ${location}.`));
    };
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.on("spawn", onSpawn);
    child.on("exit", onExit);
    child.on("error", onError);
  });
  return new ElectronInferenceProcess(child);
}

function ambientProviderEnv(providerId: string): Record<string, string> {
  const names =
    providerId === "amazon-bedrock"
      ? [
          "HOME",
          "AWS_ACCESS_KEY_ID",
          "AWS_SECRET_ACCESS_KEY",
          "AWS_SESSION_TOKEN",
          "AWS_PROFILE",
          "AWS_REGION",
          "AWS_DEFAULT_REGION",
          "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
          "AWS_CONTAINER_CREDENTIALS_FULL_URI",
          "AWS_WEB_IDENTITY_TOKEN_FILE",
          "AWS_ROLE_ARN",
          "AWS_ROLE_SESSION_NAME",
        ]
      : providerId === "google-vertex"
        ? [
            "HOME",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "GOOGLE_CLOUD_PROJECT",
            "GCLOUD_PROJECT",
            "GOOGLE_CLOUD_LOCATION",
          ]
        : [];
  return Object.fromEntries(
    names.flatMap((name) => (process.env[name] ? [[name, process.env[name] as string]] : [])),
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
    const isolatedStreamSimple = (
      model: Model<Api>,
      context: Context,
      options?: ModelsSimpleStreamOptions,
    ) =>
      lazyStream(model, async () => {
        let requestModel: Model<Api>;
        let requestOptions: ModelsSimpleStreamOptions;
        let leaseSignal: AbortSignal | undefined;
        let observeResult: ((message: AssistantMessage) => void) | undefined;
        if (model.provider === OPENAI_CODEX_PROVIDER_ID) {
          if (!runtime.prepareIsolatedStream) {
            throw new Error("OpenAI Codex isolated dispatch is unavailable.");
          }
          const lease = await runtime.prepareIsolatedStream(model, options);
          requestModel = lease.model;
          requestOptions = lease.options;
          leaseSignal = lease.signal;
          observeResult = lease.observeResult;
        } else {
          const resolution = await runtime.models.getAuth(model, {
            apiKey: options?.apiKey ?? runtime.apiKey,
            env: options?.env,
          });
          if (!resolution) throw new Error(`Provider is not configured: ${model.provider}`);
          const apiKey = options?.apiKey ?? resolution.auth.apiKey;
          let headers = mergeHeaders(
            resolution.auth.headers ?? runtime.headers,
            options?.headers,
          );
          if (options?.transformHeaders) headers = await options.transformHeaders(headers ?? {});
          requestModel = resolution.auth.baseUrl
            ? { ...model, baseUrl: resolution.auth.baseUrl }
            : model;
          const env =
            resolution.env || options?.env || Object.keys(ambientProviderEnv(model.provider)).length
              ? {
                  ...ambientProviderEnv(model.provider),
                  ...(resolution.env ?? {}),
                  ...(options?.env ?? {}),
                }
              : undefined;
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
        return this.owner.stream(
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
            onTerminal: observeResult,
          },
          leaseSignal && signal ? AbortSignal.any([leaseSignal, signal]) : (leaseSignal ?? signal),
        );
      });

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
    };
  }

  shutdown(): Promise<boolean> {
    return this.owner.shutdown();
  }
}
