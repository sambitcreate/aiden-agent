/**
 * Google sign-in for Antigravity.
 *
 * The flow follows T3 Code apps/server/src/provider/{AntigravityAuth,
 * antigravityAuthSupport,antigravityCallback}.ts @ f870c419fc (MIT).
 * Antigravity never opens a browser itself: its `BROWSER` hook prints the
 * authorization URL, Aiden validates it and hands it to its own sign-in UI,
 * and Google redirects to Antigravity's loopback listener. If that redirect
 * page cannot load, the user may paste the final URL, which is validated
 * against the pending sign-in and forwarded once to the listener.
 */
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { request as httpRequest } from "node:http";
import { readFile, rm } from "node:fs/promises";

import { agentErrorCode } from "../acp/connection.js";
import { AcpConnection } from "../acp/connection.js";
import { AcpHarnessError, errorMessage, isAbortError } from "../acp/errors.js";
import type { AcpLaunchedProcess } from "../acp/runtime.js";
import {
  ANTIGRAVITY_SIGN_IN_METHOD,
  antigravitySettingsPath,
  antigravityTokenPath,
  authorizationUrlFromStderr,
} from "./definition.js";

const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const CALLBACK_TIMEOUT_MS = 10_000;

export interface PendingAuthorization {
  url: URL;
  state: string;
  port: number;
}

/** Accept only Google's OAuth endpoint redirecting to a local loopback listener. */
export function parseAuthorizationUrl(raw: string): PendingAuthorization | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname !== "accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth") {
    return undefined;
  }
  const states = url.searchParams.getAll("state");
  if (states.length !== 1 || !states[0] || url.searchParams.get("response_type") !== "code") return undefined;
  let redirect: URL;
  try {
    redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
  } catch {
    return undefined;
  }
  const port = Number(redirect.port);
  if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" || !Number.isInteger(port) || port < 1024) {
    return undefined;
  }
  return { url, state: states[0], port };
}

/** Validate a pasted redirect URL against the pending sign-in. Returns the exact URL to forward. */
export function parseCallbackUrl(raw: string, pending: PendingAuthorization): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AcpHarnessError("invalid_input", "Paste the complete address from the page Google redirected you to.");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || Number(url.port) !== pending.port) {
    throw new AcpHarnessError("invalid_input", "This address does not belong to the current sign-in.");
  }
  const states = url.searchParams.getAll("state");
  if (states.length !== 1 || states[0] !== pending.state) {
    throw new AcpHarnessError("invalid_input", "This address does not belong to the current sign-in.");
  }
  const codes = url.searchParams.getAll("code");
  const errors = url.searchParams.getAll("error");
  if (codes.length + errors.length !== 1) {
    throw new AcpHarnessError("invalid_input", "This address is not a Google sign-in response.");
  }
  return url;
}

function forwardCallback(url: URL): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port: Number(url.port), path: `${url.pathname}${url.search}`, method: "GET", agent: false, timeout: CALLBACK_TIMEOUT_MS },
      (response) => {
        response.resume();
        response.once("end", () => resolve());
      },
    );
    request.once("timeout", () => request.destroy(new AcpHarnessError("timeout", "The sign-in response timed out. Start sign-in again.")));
    request.once("error", reject);
    request.end();
  });
}

/** Turn agent failures into specific, actionable copy. */
export function signInFailureMessage(error: unknown): string {
  const text = errorMessage(error);
  if (/SUBSCRIPTION_REQUIRED/iu.test(text)) {
    return "This Google account needs an eligible Antigravity subscription.";
  }
  if (/access_denied/iu.test(text)) return "Google sign-in was not approved. Start sign-in again.";
  if (agentErrorCode(error) === -32603) {
    return "Antigravity signed in but could not start a session. Try again in a moment.";
  }
  if (error instanceof AcpHarnessError && (error.code === "install" || error.code === "timeout")) return error.message;
  return "Google sign-in did not finish. Start sign-in again.";
}

export async function hasAntigravitySignIn(stateDir: string): Promise<boolean> {
  try {
    const token = JSON.parse(await readFile(antigravityTokenPath(stateDir), "utf8")) as { refresh_token?: unknown };
    return typeof token.refresh_token === "string" && token.refresh_token.length > 0;
  } catch {
    return false;
  }
}

export async function clearAntigravityCredentials(stateDir: string): Promise<void> {
  await Promise.all([
    rm(antigravityTokenPath(stateDir), { force: true }),
    rm(antigravitySettingsPath(stateDir), { force: true }),
  ]);
}

export interface SignInDependencies {
  /** Launch the agent for sign-in, observing stderr for the authorization URL. */
  launch(onStderrLine: (line: string) => void): Promise<AcpLaunchedProcess>;
  cwd: string;
}

export async function signInWithGoogle(interaction: AuthInteraction, dependencies: SignInDependencies): Promise<void> {
  const signal = interaction.signal ?? new AbortController().signal;
  if (signal.aborted) throw new AcpHarnessError("aborted", "Sign-in was cancelled.");
  let pending: PendingAuthorization | undefined;
  let announce: ((value: PendingAuthorization) => void) | undefined;
  const announced = new Promise<PendingAuthorization>((resolve) => {
    announce = resolve;
  });
  const launched = await dependencies.launch((line) => {
    if (pending) return;
    const raw = authorizationUrlFromStderr(line);
    const parsed = raw ? parseAuthorizationUrl(raw) : undefined;
    if (!parsed) return;
    pending = parsed;
    announce?.(parsed);
  });
  const connection = new AcpConnection(launched.process);
  const promptController = new AbortController();
  const onAbort = () => promptController.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    interaction.notify({ type: "progress", message: "Starting Google sign-in…" });
    await connection.initialize(signal);
    const authentication = connection.authenticate(ANTIGRAVITY_SIGN_IN_METHOD, signal, SIGN_IN_TIMEOUT_MS);
    authentication.catch(() => undefined);

    void announced.then((authorization) => {
      interaction.notify({
        type: "auth_url",
        url: authorization.url.toString(),
        instructions: "Finish signing in to Google in your browser.",
      });
      // Fallback for when the browser cannot reach the local redirect page.
      void (async () => {
        while (!promptController.signal.aborted) {
          let pasted: string;
          try {
            pasted = await interaction.prompt({
              type: "manual_code",
              message: "If the final page does not load, paste its full address here.",
              placeholder: "http://127.0.0.1:…/?state=…&code=…",
              signal: promptController.signal,
            });
          } catch {
            return;
          }
          try {
            await forwardCallback(parseCallbackUrl(pasted, authorization));
            return;
          } catch (error) {
            interaction.notify({ type: "info", message: errorMessage(error) });
          }
        }
      })();
    });

    await authentication;
    interaction.notify({ type: "progress", message: "Checking Antigravity access…" });
    await connection.newSession(dependencies.cwd, [], signal);
  } catch (error) {
    if (isAbortError(error) || signal.aborted) throw error;
    throw new AcpHarnessError("auth", signInFailureMessage(error), { cause: error });
  } finally {
    promptController.abort();
    signal.removeEventListener("abort", onAbort);
    await launched.dispose();
  }
}

/** Sign out through the agent when possible, then remove local credentials regardless. */
export async function signOutOfGoogle(
  stateDir: string,
  launch: (() => Promise<AcpLaunchedProcess>) | undefined,
): Promise<void> {
  if (launch && (await hasAntigravitySignIn(stateDir))) {
    let launched: AcpLaunchedProcess | undefined;
    try {
      launched = await launch();
      const connection = new AcpConnection(launched.process);
      const initialize = await connection.initialize();
      if (initialize.agentCapabilities?.auth?.logout) await connection.logout();
    } catch {
      // Local removal below is the authority; the remote logout is best effort.
    } finally {
      await launched?.dispose();
    }
  }
  await clearAntigravityCredentials(stateDir);
}
