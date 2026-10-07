// Test support: a scripted `fetch` that records what GitHub would have received.

import type { GitHubFetch } from "./github-api.js";

export interface RecordedGitHubRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  json?: { query?: string; variables?: Record<string, unknown> };
}

export type ScriptedResponder = (
  request: RecordedGitHubRequest,
  signal: AbortSignal,
) => Response | Promise<Response>;

/** A response that never arrives unless the request is aborted. */
export function hangUntilAborted(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), {
      once: true,
    });
  });
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function recordingFetch(responder: ScriptedResponder): {
  fetch: GitHubFetch;
  requests: RecordedGitHubRequest[];
} {
  const requests: RecordedGitHubRequest[] = [];
  const fetchImpl: GitHubFetch = async (url, init) => {
    if (init.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    let json: RecordedGitHubRequest["json"];
    if (init.body) {
      try {
        json = JSON.parse(init.body) as RecordedGitHubRequest["json"];
      } catch {
        json = undefined;
      }
    }
    const request: RecordedGitHubRequest = {
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(json ? { json } : {}),
    };
    requests.push(request);
    return responder(request, init.signal);
  };
  return { fetch: fetchImpl, requests };
}

export function fixedCredentials(tokens: Record<string, string>) {
  const resolves: string[] = [];
  const invalidated: string[] = [];
  return {
    resolves,
    invalidated,
    async resolve(host: string) {
      resolves.push(host);
      const token = tokens[host];
      return token
        ? { ok: true as const, credential: { host, token, fingerprint: `${host}:${token}`, source: "environment" as const } }
        : { ok: false as const, missing: { host, reason: "unauthenticated" as const, message: "Sign in." } };
    },
    invalidate(host: string) {
      invalidated.push(host);
    },
  };
}
