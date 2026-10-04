/**
 * Read an HTTP response body under a byte budget before anything parses it.
 *
 * A declared Content-Length above the budget is rejected without reading.
 * Streamed bytes are counted chunk by chunk. Every failure path, including
 * caller abort, starts best-effort cancellation of the source without waiting
 * for it, so a stalled peer cannot hold the error open, and releases the lock.
 */

export interface BoundedBodyErrors {
  /** Declared or streamed size exceeded `maxBytes`. */
  tooLarge(): unknown;
  /** No readable body. When omitted, a missing body reads as zero bytes. */
  missingBody?(): unknown;
  /** The stream yielded something other than bytes. */
  invalidChunk?(): unknown;
  /** The caller's signal aborted. Defaults to the signal's reason. */
  aborted?(signal: AbortSignal): unknown;
}

export interface BoundedBodyOptions {
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
  readonly errors: BoundedBodyErrors;
}

function cancelQuietly(source: { cancel(reason?: unknown): Promise<void> } | null | undefined): void {
  try {
    void source?.cancel().catch(() => undefined);
  } catch {
    // Cleanup is best effort, including sources that throw synchronously.
  }
}

function abortReason(signal: AbortSignal, errors: BoundedBodyErrors): unknown {
  return (
    errors.aborted?.(signal) ??
    signal.reason ??
    new DOMException("The request was aborted.", "AbortError")
  );
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  errors: BoundedBodyErrors,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) throw abortReason(signal, errors);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal, errors));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // Subscribe before read(): pulling the source may itself trigger an abort.
    return await Promise.race([aborted, reader.read()]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function readBoundedBody(
  response: Response,
  { maxBytes, signal, errors }: BoundedBodyOptions,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    cancelQuietly(response.body);
    throw errors.tooLarge();
  }
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    if (errors.missingBody) throw errors.missingBody();
    return new Uint8Array(0);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await readChunk(reader, signal, errors);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        throw errors.invalidChunk?.() ?? new TypeError("The response body is not a byte stream.");
      }
      total += chunk.value.byteLength;
      if (total > maxBytes) throw errors.tooLarge();
      chunks.push(chunk.value);
    }
  } catch (error) {
    cancelQuietly(reader);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
