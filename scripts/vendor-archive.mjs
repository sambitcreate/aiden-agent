/* global AbortController, clearTimeout, fetch, setTimeout */

import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Parse a tar listing and refuse path traversal, absolute paths, backslashes, or NULs. */
export function assertSafeArchiveListing(
  listing,
  archiveLabel,
  { rejectDotSegment = false } = {},
) {
  const names = listing.split(/\r?\n/).filter((name) => name.length > 0);
  for (const name of names) {
    const segments = name.split("/");
    if (
      name.startsWith("/") ||
      name.includes("\\") ||
      name.includes("\0") ||
      segments.some((segment) => segment === ".." || (rejectDotSegment && segment === "."))
    ) {
      throw new Error(`Refusing unsafe path in ${archiveLabel}: ${JSON.stringify(name)}`);
    }
  }
  return names;
}

/** Stream a pinned archive to a newly created 0o600 file with strict size and time bounds. */
export async function downloadPinnedArchive({
  url,
  archive,
  maxBytes,
  timeoutMs,
  downloadLabel,
  fetchImpl = fetch,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`Download failed with HTTP ${response.status}.`);
    }
    const declaredBytes = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await response.body.cancel().catch(() => {});
      throw new Error(`${downloadLabel} exceeds ${maxBytes} bytes.`);
    }
    let downloadedBytes = 0;
    const bound = new Transform({
      transform(chunk, _encoding, callback) {
        downloadedBytes += chunk.byteLength;
        callback(
          downloadedBytes > maxBytes
            ? new Error(`${downloadLabel} exceeds ${maxBytes} bytes.`)
            : undefined,
          chunk,
        );
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      bound,
      createWriteStream(archive, { flags: "wx", mode: 0o600 }),
    );
  } finally {
    clearTimeout(timeout);
  }
}
