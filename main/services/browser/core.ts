import { createHash } from "node:crypto";

export const BROWSER_MAX_TABS = 24;
export const BROWSER_MAX_RESULT_BYTES = 256_000;
export const BROWSER_ZOOM_LEVELS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
];

export function browserUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8_192)
    throw new Error("Enter a valid browser URL.");
  const input = value.trim();
  if (!input || input === "about:blank") return "about:blank";
  const explicit = /^[a-z][a-z\d+.-]*:/i.test(input) && !/^[^/]+:\d+(?:\/|$)/.test(input);
  const loopback = /^(?:localhost|127(?:\.\d+){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(input);
  const candidate = explicit ? input : `${loopback ? "http" : "https"}://${input}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Enter a valid browser URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "Browser navigation requires an HTTP or HTTPS URL without embedded credentials.",
    );
  }
  return url.href;
}

export function browserDisplayUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.searchParams.has("__aiden_preview")
    ) {
      url.searchParams.delete("__aiden_preview");
      return url.href;
    }
  } catch {
    /* about:blank and pending navigation are preserved. */
  }
  return value;
}

/** CDP accessibility nodes also include the main-frame URL as a nested property. */
export function browserRedactPreviewUrls<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "string" && entry.includes("__aiden_preview") ? browserDisplayUrl(entry) : entry,
  )) as T;
}

/** Native slot bounds include letterboxing; captures must contain only the scaled page. */
export function browserPageCaptureBounds(
  slot: { width: number; height: number },
  viewport: { mode: string; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const scale =
    viewport.mode === "responsive"
      ? Math.min(1, slot.width / viewport.width, slot.height / viewport.height)
      : 1;
  return {
    x: 0,
    y: 0,
    width: Math.max(
      1,
      Math.round(viewport.mode === "responsive" ? viewport.width * scale : slot.width),
    ),
    height: Math.max(
      1,
      Math.round(viewport.mode === "responsive" ? viewport.height * scale : slot.height),
    ),
  };
}

/** JSON preserves lone surrogates, keeping distinct profile identities isolated. */
export function browserPartition(profileId: string, incognito: boolean): string {
  const digest = createHash("sha256").update(JSON.stringify(profileId)).digest("hex").slice(0, 32);
  return `${incognito ? "" : "persist:"}aiden-browser-${incognito ? "private-" : "profile-"}${digest}`;
}

export function browserBoundedNumber(
  value: unknown,
  min: number,
  max: number,
  label: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

export function browserAbort(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error("Browser action cancelled.");
}

export async function browserDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<T> {
  browserAbort(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Browser action timed out.")), milliseconds);
        aborted = () =>
          reject(
            signal?.reason instanceof Error
              ? signal.reason
              : new Error("Browser action cancelled."),
          );
        signal?.addEventListener("abort", aborted, { once: true });
        if (signal?.aborted) aborted();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (aborted) signal?.removeEventListener("abort", aborted);
  }
}

export function browserResult(value: unknown): unknown {
  const text = JSON.stringify(value ?? null);
  if (Buffer.byteLength(text) > BROWSER_MAX_RESULT_BYTES)
    throw new Error("Browser result is too large. Return a smaller value.");
  return JSON.parse(text);
}

/** Extract only URLs printed by the workspace terminal; never scan or probe ports. */
export function browserLocalServers(output: string): Array<{ url: string; label: string }> {
  // Terminal ANSI escape sequences are data, not URL characters.
  // eslint-disable-next-line no-control-regex
  const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const matches =
    clean.match(
      /https?:\/\/(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\]|\[::\])(?::\d{1,5})?(?:\/[^\s<>"'`]*)?/gi,
    ) ?? [];
  return [...new Set(matches)].slice(-12).flatMap((raw) => {
    try {
      const normalized = raw
        .replace(/0\.0\.0\.0/, "localhost")
        .replace("[::]", "[::1]")
        .replace(/[),.;]+$/, "");
      const url = browserUrl(normalized);
      return [{ url, label: new URL(url).host }];
    } catch {
      return [];
    }
  });
}

export class BrowserActionQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private controller?: AbortController;
  get signal(): AbortSignal | undefined {
    return this.controller?.signal;
  }
  epoch = 0;
  interrupt(): void {
    this.epoch += 1;
    this.controller?.abort(new Error("Browser action interrupted by user input or a closed tab."));
  }
  async run<T>(operation: (check: () => void) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const epoch = this.epoch;
    const check = () => {
      browserAbort(signal);
      if (epoch !== this.epoch)
        throw new Error("Browser action interrupted by user input or a closed tab.");
    };
    const next = this.tail
      .catch(() => {})
      .then(async () => {
        check();
        const controller = new AbortController();
        this.controller = controller;
        try {
          const result = await operation(check);
          check();
          return result;
        } finally {
          if (this.controller === controller) this.controller = undefined;
        }
      });
    this.tail = next;
    return next;
  }
}
