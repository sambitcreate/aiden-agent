export const MAX_SUBAGENT_MCP_RAW_RESPONSE_BYTES = 256 * 1024;

const OVERSIZED_RESPONSE = "MCP response exceeded the subagent transport limit.";

function contentLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null) return undefined;
  if (!/^\d+$/u.test(raw)) throw new Error(OVERSIZED_RESPONSE);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(OVERSIZED_RESPONSE);
  return value;
}

function boundedBody(
  body: ReadableStream<Uint8Array>,
  maximumBytes: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let observed = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        observed += next.value.byteLength;
        if (observed > maximumBytes) {
          await reader.cancel(OVERSIZED_RESPONSE).catch(() => undefined);
          controller.error(new Error(OVERSIZED_RESPONSE));
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * Child MCP HTTP/SSE fetch boundary. Redirects fail closed and every decoded
 * response stream is byte-counted before the SDK can materialize JSON or SSE.
 */
export function createBoundedSubagentMcpFetch(
  fetchImpl: typeof fetch = globalThis.fetch,
  maximumBytes = MAX_SUBAGENT_MCP_RAW_RESPONSE_BYTES,
): typeof fetch {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("Invalid subagent MCP transport limit.");
  }
  return (async (request, init) => {
    const response = await fetchImpl(request, { ...init, redirect: "error" });
    const declared = contentLength(response);
    if (declared !== undefined && declared > maximumBytes) {
      await response.body?.cancel(OVERSIZED_RESPONSE).catch(() => undefined);
      throw new Error(OVERSIZED_RESPONSE);
    }
    if (!response.body) return response;
    return new Response(boundedBody(response.body, maximumBytes), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;
}
