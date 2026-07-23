import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app } from "../platform.js";
import { isPackagedRuntime } from "../runtime-mode.js";
import {
  FOUNDATION_MODELS_PROTOCOL_VERSION,
  FoundationModelsConnectionError,
  createFoundationModelsConnection,
  parseFoundationModelsResponse,
  type NativeFoundationModelsRequest,
  type NativeFoundationModelsResponse,
  type NativeFoundationModelsRunOptions,
} from "./foundation-models-connection-core.js";

const HELPER_APP_NAME = "Aiden Foundation Models Helper.app";
const MAX_REQUEST_BYTES = 20_000;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const activeHelperRequests = new Set<{ dispose: () => void }>();
let isDisposingFoundationModelsConnection = false;

function helperEnvironment(): NodeJS.ProcessEnv {
  const safeNames = ["HOME", "LANG", "LC_ALL", "TMPDIR", "USER", "__CF_USER_TEXT_ENCODING"];
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const name of safeNames) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

function defaultHelperPath(): string {
  if (isPackagedRuntime()) {
    return path.resolve(process.resourcesPath, "..", "Helpers", HELPER_APP_NAME);
  }
  return path.join(app.getAppPath(), "build", "native", HELPER_APP_NAME);
}

async function runHelperRequest(
  request: NativeFoundationModelsRequest,
  options: NativeFoundationModelsRunOptions,
): Promise<NativeFoundationModelsResponse> {
  const payload = Buffer.from(JSON.stringify(request), "utf8");
  if (payload.byteLength > MAX_REQUEST_BYTES) {
    return Promise.reject(
      new FoundationModelsConnectionError("invalid_request", "The native title request is too large."),
    );
  }
  if (options.signal?.aborted) {
    throw new FoundationModelsConnectionError("cancelled", "Title generation was cancelled.");
  }
  if (isDisposingFoundationModelsConnection) {
    throw new FoundationModelsConnectionError("cancelled", "Title generation was cancelled.");
  }

  const exchangeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-foundation-models-"));
  const requestPath = path.join(exchangeDirectory, "request.json");
  const responsePath = path.join(exchangeDirectory, "response.json");
  const processPath = path.join(exchangeDirectory, "process-id");
  const cancellationPath = path.join(exchangeDirectory, "cancelled");
  try {
    await fs.chmod(exchangeDirectory, 0o700);
    await fs.writeFile(requestPath, payload, { mode: 0o600 });
  } catch {
    await fs.rm(exchangeDirectory, { recursive: true, force: true });
    throw new FoundationModelsConnectionError("helper_failed", "The native title request could not be prepared.");
  }
  if (options.signal?.aborted || isDisposingFoundationModelsConnection) {
    await fs.rm(exchangeDirectory, { recursive: true, force: true });
    throw new FoundationModelsConnectionError("cancelled", "Title generation was cancelled.");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/open",
      [
        "-W",
        "-n",
        defaultHelperPath(),
        "--args",
        "--request-file",
        requestPath,
        "--response-file",
        responsePath,
        "--process-file",
        processPath,
        "--cancellation-file",
        cancellationPath,
      ],
      {
        env: helperEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let pendingStopError: FoundationModelsConnectionError | null = null;
    let forcedFinish: ReturnType<typeof setTimeout> | undefined;

    const cleanupExchange = () => {
      rmSync(exchangeDirectory, { recursive: true, force: true });
    };

    const terminateHelper = () => {
      try {
        writeFileSync(cancellationPath, "", { mode: 0o600 });
      } catch {
        // Removing the request below still prevents a late launch from generating.
      }
      try {
        if (existsSync(processPath)) {
          const processId = Number.parseInt(readFileSync(processPath, "utf8"), 10);
          if (Number.isSafeInteger(processId) && processId > 1) process.kill(processId, "SIGTERM");
        }
      } catch {
        // The helper may already have exited between reading its pid and signalling it.
      }
      if (!child.killed) child.kill("SIGTERM");
    };

    const finish = (error?: Error, response?: NativeFoundationModelsResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forcedFinish) clearTimeout(forcedFinish);
      options.signal?.removeEventListener("abort", abort);
      activeHelperRequests.delete(activeRequest);
      cleanupExchange();
      if (error) reject(error);
      else if (response) resolve(response);
      else reject(new FoundationModelsConnectionError("helper_failed", "The native helper failed."));
    };
    const requestStop = (error: FoundationModelsConnectionError) => {
      if (settled || pendingStopError) return;
      pendingStopError = error;
      terminateHelper();
      forcedFinish = setTimeout(() => finish(error), 2_000);
    };
    const abort = () => {
      requestStop(new FoundationModelsConnectionError("cancelled", "Title generation was cancelled."));
    };
    const timeout = setTimeout(() => {
      requestStop(new FoundationModelsConnectionError("timeout", "The native helper timed out.", true));
    }, options.timeoutMs);
    const activeRequest = {
      dispose: () => {
        terminateHelper();
        finish(new FoundationModelsConnectionError("cancelled", "Title generation was cancelled."));
      },
    };
    activeHelperRequests.add(activeRequest);

    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "helper_missing" : "helper_failed";
      finish(new FoundationModelsConnectionError(code, "The Apple Foundation Models helper is unavailable."));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        requestStop(
          new FoundationModelsConnectionError(
            "output_too_large",
            "The native helper returned too much data.",
          ),
        );
        return;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_STDERR_BYTES) {
        requestStop(
          new FoundationModelsConnectionError(
            "output_too_large",
            "The native helper returned too much diagnostic data.",
          ),
        );
      }
    });
    child.on("close", async (exitCode) => {
      if (settled) return;
      if (pendingStopError) {
        finish(pendingStopError);
        return;
      }
      try {
        if (exitCode !== 0) {
          throw new FoundationModelsConnectionError("helper_failed", "The Apple Foundation Models helper failed.");
        }
        const responseStat = await fs.stat(responsePath);
        if (responseStat.size > MAX_STDOUT_BYTES) {
          throw new FoundationModelsConnectionError(
            "output_too_large",
            "The native helper returned too much data.",
          );
        }
        const response = parseFoundationModelsResponse(await fs.readFile(responsePath, "utf8"));
        finish(undefined, response);
      } catch (error) {
        finish(
          error instanceof FoundationModelsConnectionError
            ? error
            : new FoundationModelsConnectionError("helper_failed", "The native helper failed."),
        );
      }
    });
  });
}

function currentSystemVersion(): string {
  const electronProcess = process as NodeJS.Process & { getSystemVersion?: () => string };
  return electronProcess.getSystemVersion?.() ?? "0";
}

export const foundationModelsConnection = createFoundationModelsConnection({
  platform: process.platform,
  arch: process.arch,
  systemVersion: currentSystemVersion(),
  now: Date.now,
  runRequest: runHelperRequest,
});

export function disposeFoundationModelsConnection(): void {
  isDisposingFoundationModelsConnection = true;
  for (const request of [...activeHelperRequests]) request.dispose();
}

export { FOUNDATION_MODELS_PROTOCOL_VERSION };
