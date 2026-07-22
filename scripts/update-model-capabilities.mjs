/* global AbortController, Buffer, clearTimeout, console, process, setTimeout */

import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_MODELS_DEV_SNAPSHOT_BYTES,
  serializeModelsDevSnapshot,
  validateModelsDevSnapshot,
} from "./model-snapshot-core.mjs";

const modulePath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(modulePath), "..");
const destination = resolve(projectRoot, "resources", "model-capabilities.json");
const MODELS_DEV_ENDPOINT = "https://models.dev/api.json";
const DEFAULT_TIMEOUT_MS = 30_000;

async function readBoundedBody(response, signal) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MODELS_DEV_SNAPSHOT_BYTES) {
    throw new Error("models.dev returned more data than the release refresh can safely process.");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_MODELS_DEV_SNAPSHOT_BYTES) {
        await reader.cancel();
        throw new Error(
          "models.dev returned more data than the release refresh can safely process.",
        );
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function fetchModelsDev(fetchImpl, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("models.dev refresh timeout must be positive.");
  }
  const controller = new AbortController();
  const deadlineError = new Error(
    "models.dev did not respond before the release refresh deadline.",
  );
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(deadlineError);
      controller.abort(deadlineError);
    }, timeoutMs);
  });
  const request = (async () => {
    const response = await fetchImpl(MODELS_DEV_ENDPOINT, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    const body = await readBoundedBody(response, controller.signal);
    if (!response.ok) {
      throw new Error(
        `models.dev request failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 240)}` : ""}`,
      );
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error("models.dev returned malformed JSON.");
    }
    return validateModelsDevSnapshot(payload);
  })();
  try {
    return await Promise.race([request, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function writeSnapshot(
  snapshot,
  destinationPath,
  maximumBytes = MAX_MODELS_DEV_SNAPSHOT_BYTES,
) {
  const serialized = serializeModelsDevSnapshot(snapshot, maximumBytes);
  const temporary = `${destinationPath}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(dirname(destinationPath), { recursive: true });
  try {
    await writeFile(temporary, serialized, "utf8");
    await rename(temporary, destinationPath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function updateModelCapabilities(options = {}) {
  const snapshot = await fetchModelsDev(
    options.fetch ?? globalThis.fetch,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  await writeSnapshot(snapshot, options.destination ?? destination);
  try {
    (options.log ?? console.log)(
      `Updated models.dev capability snapshot for ${Object.keys(snapshot).length} providers.`,
    );
  } catch {
    // A diagnostic failure cannot turn an already committed snapshot into a failed refresh.
  }
  return snapshot;
}

if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  updateModelCapabilities().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
