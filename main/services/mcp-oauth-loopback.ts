// Short-lived loopback listener that receives the OAuth authorization code
// (RFC 8252 native-app flow). Every MCP server shares one fixed redirect port,
// so only one sign-in can wait in the browser at a time; a second one gets a
// clear error naming the sign-in that holds the port.

import * as http from "node:http";

export interface McpOAuthLoopback {
  waitForCode(): Promise<string>;
  /** Stop listening and free the port. Safe to call more than once. */
  close(): void;
}

export interface McpOAuthLoopbackOptions {
  port: number;
  redirectUri: string;
  /** Names the sign-in in the error another sign-in sees while this one waits. */
  label: string;
  timeoutMs: number;
  callbackHtml: string;
  authorization: { callback(url: URL): { code: string } | { error: Error } };
  /** Aborting rejects the pending code and frees the port at once. */
  signal?: AbortSignal;
  host?: string;
}

/** Process-wide owner of each loopback port: one waiting sign-in per port. */
const holders = new Map<number, { label: string }>();

export function mcpOAuthLoopbackHolder(port: number): string | undefined {
  return holders.get(port)?.label;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Sign-in was cancelled.");
}

export function startMcpOAuthLoopback(options: McpOAuthLoopbackOptions): Promise<McpOAuthLoopback> {
  const { port } = options;
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
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", options.redirectUri);
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
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(options.callbackHtml);
      if ("error" in callback) rejectCode(callback.error);
      else resolveCode(callback.code);
    });

    const close = (): void => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (holders.get(port) === ownership) holders.delete(port);
      if (listening) {
        server.close();
        server.closeAllConnections?.();
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
        waitForCode: () => codePromise.finally(() => clearTimeout(timer)),
        close,
      });
    });
  });
}
