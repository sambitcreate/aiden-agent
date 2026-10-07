import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";

import { buildChildEnvironment } from "../acp/environment.js";
import { AcpPidLedger } from "../acp/pid-ledger.js";
import { AcpRuntimeLauncher } from "../acp/launcher.js";
import { FAKE_AGENT, fakeDefinition, tempDir } from "../acp/test-support.js";
import {
  hasAntigravitySignIn,
  parseAuthorizationUrl,
  parseCallbackUrl,
  signInFailureMessage,
  signInWithGoogle,
  signOutOfGoogle,
} from "./auth.js";
import { AUTH_URL_MARKER, antigravityProfileDir, antigravityTokenPath } from "./definition.js";

const GOOGLE = "https://accounts.google.com/o/oauth2/v2/auth";

test("only Google's OAuth endpoint redirecting to a high loopback port is accepted", () => {
  const good = `${GOOGLE}?response_type=code&state=abc&redirect_uri=${encodeURIComponent("http://127.0.0.1:51234/")}`;
  assert.deepEqual(
    { state: parseAuthorizationUrl(good)?.state, port: parseAuthorizationUrl(good)?.port },
    { state: "abc", port: 51234 },
  );
  for (const bad of [
    good.replace("accounts.google.com", "accounts.google.com.evil.example"),
    good.replace("https:", "http:"),
    good.replace("51234", "80"),
    good.replace("127.0.0.1", "example.com"),
    `${good}&state=second`,
    good.replace("response_type=code", "response_type=token"),
    "not a url",
  ]) {
    assert.equal(parseAuthorizationUrl(bad), undefined, bad);
  }
});

test("a pasted redirect must match the pending sign-in exactly", () => {
  const pending = parseAuthorizationUrl(
    `${GOOGLE}?response_type=code&state=abc&redirect_uri=${encodeURIComponent("http://127.0.0.1:51234/")}`,
  )!;
  assert.equal(parseCallbackUrl("http://127.0.0.1:51234/?state=abc&code=4/xyz", pending).searchParams.get("code"), "4/xyz");
  assert.throws(() => parseCallbackUrl("http://127.0.0.1:51234/?state=other&code=1", pending), /does not belong/u);
  assert.throws(() => parseCallbackUrl("http://127.0.0.1:9999/?state=abc&code=1", pending), /does not belong/u);
  assert.throws(() => parseCallbackUrl("http://127.0.0.1:51234/?state=abc", pending), /not a Google sign-in response/u);
  assert.throws(() => parseCallbackUrl("http://127.0.0.1:51234/?state=abc&code=1&error=x", pending), /not a Google/u);
  assert.throws(() => parseCallbackUrl("whatever", pending), /complete address/u);
});

test("agent failures become specific, actionable messages", () => {
  assert.match(signInFailureMessage(new Error("SUBSCRIPTION_REQUIRED for account")), /eligible Antigravity subscription/u);
  assert.match(signInFailureMessage(new Error("access_denied")), /not approved/u);
  assert.match(signInFailureMessage(new Error("boom")), /did not finish/u);
});

function launcherFor(stateDir: string) {
  const definition = {
    ...fakeDefinition,
    async prepareLaunch(context: Parameters<typeof fakeDefinition.prepareLaunch>[0]) {
      return {
        command: process.execPath,
        args: [FAKE_AGENT],
        env: buildChildEnvironment({
          set: {
            GEMINI_HOME: antigravityProfileDir(context.stateDir),
            ...(context.browserHook ? { BROWSER: context.browserHook } : {}),
          },
        }),
      };
    },
  };
  return new AcpRuntimeLauncher({
    definition,
    // The sign-in launch never touches the installer when a lease is supplied.
    installer: { acquire: () => ({ runtimeDir: stateDir, asset: { url: "", sha256: "", archiveBytes: 0, members: [], executable: "", args: [] }, version: "1", release() {} }) } as never,
    stateDir,
    tmpRoot: path.join(stateDir, "tmp"),
    ledger: new AcpPidLedger(path.join(stateDir, "processes.json")),
    browserUrlMarker: AUTH_URL_MARKER,
  });
}

function interaction(onUrl: (url: string) => void, pasted?: () => Promise<string>) {
  const events: AuthEvent[] = [];
  const prompts: AuthPrompt[] = [];
  return {
    events,
    prompts,
    value: {
      signal: new AbortController().signal,
      notify(event: AuthEvent) {
        events.push(event);
        if (event.type === "auth_url") onUrl(event.url);
      },
      prompt(prompt: AuthPrompt) {
        prompts.push(prompt);
        if (pasted) return pasted();
        return new Promise<string>((_resolve, reject) => {
          prompt.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    },
  };
}

test("sign-in shows Google's URL, finishes when the browser redirects, and stores the token in the private profile", async () => {
  const stateDir = tempDir();
  const launcher = launcherFor(stateDir);
  const flow = interaction((url) => {
    // Simulate the browser completing Google's consent and redirecting.
    const parsed = new URL(url);
    const redirect = new URL(parsed.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("state", parsed.searchParams.get("state")!);
    redirect.searchParams.set("code", "4/approved");
    void fetch(redirect).catch(() => undefined);
  });
  await signInWithGoogle(flow.value, { cwd: stateDir, launch: (onLine) => launcher.launch("auth", stateDir, { onStderrLine: onLine }) });
  assert.ok(flow.events.some((event) => event.type === "auth_url" && event.url.startsWith(GOOGLE)));
  assert.equal(await hasAntigravitySignIn(stateDir), true);
  assert.ok(existsSync(antigravityTokenPath(stateDir)));
});

test("when the redirect page cannot load, a pasted address completes sign-in", async () => {
  const stateDir = tempDir();
  const launcher = launcherFor(stateDir);
  let authorization: URL | undefined;
  const flow = interaction(
    (url) => {
      authorization = new URL(url);
    },
    async () => {
      while (!authorization) await new Promise((resolve) => setTimeout(resolve, 20));
      const redirect = new URL(authorization.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("state", authorization.searchParams.get("state")!);
      redirect.searchParams.set("code", "4/pasted");
      return redirect.toString();
    },
  );
  await signInWithGoogle(flow.value, { cwd: stateDir, launch: (onLine) => launcher.launch("auth", stateDir, { onStderrLine: onLine }) });
  assert.equal(flow.prompts[0]?.type, "manual_code");
  assert.equal(await hasAntigravitySignIn(stateDir), true);
});

test("a declined consent fails with a clear message and stores nothing", async () => {
  const stateDir = tempDir();
  const launcher = launcherFor(stateDir);
  const flow = interaction((url) => {
    const parsed = new URL(url);
    const redirect = new URL(parsed.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("state", parsed.searchParams.get("state")!);
    redirect.searchParams.set("error", "access_denied");
    void fetch(redirect).catch(() => undefined);
  });
  await assert.rejects(
    signInWithGoogle(flow.value, { cwd: stateDir, launch: (onLine) => launcher.launch("auth", stateDir, { onStderrLine: onLine }) }),
    /not approved/u,
  );
  assert.equal(await hasAntigravitySignIn(stateDir), false);
});

test("sign-out removes local credentials even when the agent cannot be started", async () => {
  const stateDir = tempDir();
  const launcher = launcherFor(stateDir);
  const flow = interaction((url) => {
    const parsed = new URL(url);
    const redirect = new URL(parsed.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("state", parsed.searchParams.get("state")!);
    redirect.searchParams.set("code", "4/ok");
    void fetch(redirect).catch(() => undefined);
  });
  await signInWithGoogle(flow.value, { cwd: stateDir, launch: (onLine) => launcher.launch("auth", stateDir, { onStderrLine: onLine }) });
  await signOutOfGoogle(stateDir, async () => {
    throw new Error("runtime missing");
  });
  assert.equal(await hasAntigravitySignIn(stateDir), false);
});
