/** Shared bounded response reading and best-effort transport cleanup. */
import { webSearchError } from "./web-search-core.js";
import type { WebSearchProviderId } from "./web-search-provider-registry-core.js";

/**
 * Start cancellation without waiting for the underlying source to acknowledge
 * it. A pending cleanup promise must not hold an abort, byte-limit failure, or
 * HTTP error open past the request deadline. Consume cleanup rejections so they
 * neither replace the closed provider error nor become unhandled rejections.
 */
export function cancelWebSearchResponse(
  source: { cancel(): Promise<void> } | null | undefined,
): void {
  try {
    void source?.cancel().catch(() => undefined);
  } catch {
    // Cleanup is best effort, including sources that throw synchronously.
  }
}

async function raceReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw new DOMException("The request was aborted.", "AbortError");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("The request was aborted.", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // Subscribe before read(): pulling the source may itself trigger an abort.
    return await Promise.race([aborted, reader.read()]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Read an HTTP body before parsing it; declared and streamed bytes are bounded. */
export async function readBoundedWebSearchResponse(
  response: Response,
  signal: AbortSignal,
  maximumBytes: number,
  providerId: WebSearchProviderId = "exa",
): Promise<Uint8Array> {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null && /^\d+$/u.test(rawLength) && Number(rawLength) > maximumBytes) {
    cancelWebSearchResponse(response.body);
    throw webSearchError("invalid-response", providerId);
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw webSearchError("invalid-response", providerId);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await raceReader(reader, signal);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        throw webSearchError("invalid-response", providerId);
      }
      total += chunk.value.byteLength;
      if (total > maximumBytes) throw webSearchError("invalid-response", providerId);
      chunks.push(chunk.value);
    }
  } catch (error) {
    cancelWebSearchResponse(reader);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
