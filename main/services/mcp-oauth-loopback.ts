// Short-lived loopback listener that receives the OAuth authorization code
// (RFC 8252 native-app flow). Every MCP server shares one fixed redirect port,
// so only one sign-in can wait in the browser at a time; a second one gets a
// clear error naming the sign-in that holds the port.
//
// The browser tab that delivered the code is answered only once the sign-in
// has an outcome (`finish`), so it never says "Connected" before the code
// exchange worked. A callback that carries an OAuth error is answered with a
// failure page at once.

import * as http from "node:http";

/** Outcome shown in the browser tab after the redirect. */
export type McpOAuthCallbackPage = { ok: true } | { ok: false; message: string };

export interface McpOAuthLoopback {
  /** The redirect URI it receives on (with the bound port when `port` was 0). */
  readonly redirectUri: string;
  waitForCode(): Promise<string>;
  /** Answer the browser tab that delivered the code. Only the first answer counts. */
  finish(page: McpOAuthCallbackPage): void;
  /**
   * Stop listening and free the port. A browser tab still waiting for an
   * answer gets a failure page. Safe to call more than once.
   */
  close(): void;
}

export interface McpOAuthLoopbackOptions {
  /** 0 binds any free port (tests); the redirect URI then names the bound one. */
  port: number;
  redirectUri: string;
  /** Names the sign-in in the error another sign-in sees while this one waits. */
  label: string;
  timeoutMs: number;
  authorization: { callback(url: URL): { code: string } | { error: Error } };
  /** Aborting rejects the pending code and frees the port at once. */
  signal?: AbortSignal;
  host?: string;
  /** Browser page for an outcome; defaults to Aiden's page. */
  renderPage?: (page: McpOAuthCallbackPage) => string;
}

/** Process-wide owner of each loopback port: one waiting sign-in per port. */
const holders = new Map<number, { label: string }>();

export function mcpOAuthLoopbackHolder(port: number): string | undefined {
  return holders.get(port)?.label;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Sign-in was cancelled.");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
}

const UNFINISHED = "Sign-in did not finish. Return to Aiden Agent to see what happened.";

/** Aiden's browser page after the OAuth redirect. */
export function mcpOAuthCallbackPageHtml(page: McpOAuthCallbackPage): string {
  const title = page.ok ? "Connected" : "Sign-in failed";
  const detail = page.ok
    ? "You can return to Aiden Agent and close this tab."
    : `${page.message} You can close this tab and try again from Aiden Agent.`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Aiden Agent</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#1c1c1e;color:#fff;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center;max-width:32rem;padding:0 1.5rem}
h1{font-size:17px;font-weight:600;margin:0 0 6px}p{font-size:13px;color:#98989d;margin:0}</style></head>
<body><div><h1>${title}</h1><p>${escapeHtml(detail)}</p></div></body></html>`;
}

export function startMcpOAuthLoopback(options: McpOAuthLoopbackOptions): Promise<McpOAuthLoopback> {
  const { port } = options;
  let redirectUri = options.redirectUri;
  const render = options.renderPage ?? mcpOAuthCallbackPageHtml;
  if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
  const holder = holders.get(port)?.label;
  if (holder !== undefined) {
    return Promise.reject(
      new Error(
        `Another sign-in (“${holder}”) is waiting in your browser. Finish or cancel it, then try again.`,
      ),
    );
  }
  const ownership = { label: options.label };
  holders.set(port, ownership);

  return new Promise((resolve, reject) => {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    // The callback can arrive while the initial transport is still settling.
    void codePromise.catch(() => undefined);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let listening = false;
    /** The browser request that delivered the code, answered by `finish`. */
    let waiting: http.ServerResponse | undefined;
    let answered = false;

    const answer = (res: http.ServerResponse, page: McpOAuthCallbackPage): void => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", connection: "close" });
      res.end(render(page));
    };

    const finish = (page: McpOAuthCallbackPage): void => {
      if (answered) return;
      answered = true;
      const res = waiting;
      waiting = undefined;
      if (res && !res.writableEnded) answer(res, page);
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (req.method !== "GET" || url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      let callback: ReturnType<McpOAuthLoopbackOptions["authorization"]["callback"]>;
      try {
        callback = options.authorization.callback(url);
      } catch {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("Invalid OAuth callback. Return to the sign-in window and try again.");
        return;
      }
      if ("error" in callback) {
        answered = true;
        answer(res, { ok: false, message: callback.error.message });
        rejectCode(callback.error);
        return;
      }
      waiting = res;
      resolveCode(callback.code);
    });

    const close = (): void => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (holders.get(port) === ownership) holders.delete(port);
      finish({ ok: false, message: UNFINISHED });
      if (listening) {
        // Stop listening now (the port is free at once); a tab still being
        // answered gets its page before its connection closes.
        server.close();
        server.closeIdleConnections?.();
        setTimeout(() => server.closeAllConnections?.(), 1_000).unref?.();
      }
    };
    const onAbort = (): void => {
      const reason = abortReason(options.signal!);
      rejectCode(reason);
      if (!listening) reject(reason);
      close();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (listening) return;
      close();
      reject(
        err.code === "EADDRINUSE"
          ? new Error(
              `Port ${port} is in use by another app, so the sign-in callback cannot be received. Close whatever is using it and try again.`,
            )
          : err,
      );
    });

    server.listen(port, options.host ?? "127.0.0.1", () => {
      listening = true;
      if (port === 0) {
        const bound = new URL(options.redirectUri);
        bound.port = String((server.address() as import("node:net").AddressInfo).port);
        redirectUri = bound.href;
      }
      if (closed) {
        server.close();
        return;
      }
      // A socket error after listen (for example the interface going away)
      // ends this sign-in instead of crashing the main process.
      server.on("error", (error: Error) => {
        rejectCode(error);
        close();
      });
      timer = setTimeout(() => rejectCode(new Error("Sign-in timed out.")), options.timeoutMs);
      resolve({
        redirectUri,
        waitForCode: () => codePromise.finally(() => clearTimeout(timer)),
        finish,
        close,
      });
    });
  });
}
