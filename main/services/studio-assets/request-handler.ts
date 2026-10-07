import { StudioAssetError, type StudioAssetMediaType } from "./contract.js";
import { studioAssetGrantToken, type StudioAssetGrants } from "./delivery-core.js";
import type { StudioAssetStore } from "./store.js";

type FailureStatus = 404 | 405 | 500 | 503;

const FAILURE_TEXT: Record<FailureStatus, string> = {
  404: "Not found",
  405: "Method not allowed",
  500: "Internal error",
  503: "Unavailable",
};

function failure(code: FailureStatus): Response {
  return new Response(FAILURE_TEXT[code], {
    status: code,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function failureForError(error: unknown): Response {
  if (error instanceof StudioAssetError) {
    if (error.code === "not_found") return failure(404);
    if (error.code === "unavailable") return failure(503);
  }
  // Never echo paths or driver messages to the renderer.
  return failure(500);
}

/** Pure `aiden-asset:` handler; `protocol.ts` installs it once. */
export function createStudioAssetRequestHandler(deps: {
  store: Pick<StudioAssetStore, "read" | "thumbnail">;
  grants: Pick<StudioAssetGrants, "resolve">;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return failure(405);
    const token = studioAssetGrantToken(request.url);
    const grant = token ? deps.grants.resolve(token) : undefined;
    if (!grant) return failure(404);
    let body: { bytes: Uint8Array; mediaType: StudioAssetMediaType };
    try {
      if (grant.rendition === "original") {
        const { record, bytes } = await deps.store.read(grant.assetId);
        body = { bytes, mediaType: record.mediaType };
      } else {
        body = await deps.store.thumbnail(grant.assetId, grant.rendition === "thumb-256" ? 256 : 512);
      }
    } catch (error) {
      return failureForError(error);
    }
    return new Response(request.method === "HEAD" ? null : Buffer.from(body.bytes), {
      status: 200,
      headers: {
        "content-type": body.mediaType,
        "cache-control": "no-store",
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
      },
    });
  };
}
