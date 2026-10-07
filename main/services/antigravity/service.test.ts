import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AssistantMessage, AuthEvent } from "@earendil-works/pi-ai";

import { currentPlatformKey, type AcpRelease } from "../acp/harness.js";
import { acpHosts } from "../acp/hosts.js";
import { FAKE_AGENT, RecordingHost, storedZip, tempDir, transcript, userMessage } from "../acp/test-support.js";
import { projectNativeModels } from "./models.js";
import { AntigravityService } from "./service.js";

const VERSION = "1.3.0";
// The fake account's catalog, projected the way discovery would.
const FAKE_MODEL = projectNativeModels([
  { value: "fake-flash-low", name: "Fake Flash (Low)" },
  { value: "fake-flash-high", name: "Fake Flash (High)" },
])[0]!;

/** A runtime whose "server" launches the fake ACP agent, posing as Antigravity. */
function fakeRuntime(): { release: AcpRelease; archive: Buffer } {
  const server = Buffer.from(
    `#!/bin/sh\nFAKE_AGENT_NAME=antigravity-acp FAKE_AGENT_VERSION=${VERSION} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_AGENT)} "$@"\n`,
  );
  const harness = Buffer.from("#!/bin/sh\nexit 0\n");
  const archive = storedZip([
    { name: "agy_acp_server.par", data: server },
    { name: "localharness_external", data: harness },
  ]);
  const platform = currentPlatformKey();
  assert.ok(platform, "tests run on a supported platform");
  return {
    archive,
    release: {
      version: VERSION,
      platforms: {
        [platform]: {
          url: "https://dl.google.com/fake.zip",
          sha256: createHash("sha256").update(archive).digest("hex"),
          archiveBytes: archive.length,
          members: [
            { name: "agy_acp_server.par", bytes: server.length },
            { name: "localharness_external", bytes: harness.length },
          ],
          executable: "agy_acp_server.par",
          args: [],
        },
      },
    },
  };
}

function service(baseDir: string, runtime: ReturnType<typeof fakeRuntime>) {
  let fetches = 0;
  const created = new AntigravityService({
    baseDir,
    release: runtime.release,
    fetch: (async () => {
      fetches += 1;
      return new Response(new Uint8Array(runtime.archive));
    }) as typeof fetch,
  });
  return { service: created, fetches: () => fetches };
}

function approveRedirect(event: AuthEvent): void {
  if (event.type !== "auth_url") return;
  const url = new URL(event.url);
  const redirect = new URL(url.searchParams.get("redirect_uri")!);
  redirect.searchParams.set("state", url.searchParams.get("state")!);
  redirect.searchParams.set("code", "4/ok");
  void fetch(redirect).catch(() => undefined);
}

async function chat(target: AntigravityService, chatId: string, text: string): Promise<AssistantMessage> {
  return target.runtime
    .stream(FAKE_MODEL, transcript([userMessage(text)]), { sessionId: chatId })
    .result();
}

test("install, sign in, restart, and chat without opening Settings first", { skip: process.platform === "win32" }, async () => {
  const baseDir = tempDir();
  const runtime = fakeRuntime();
  const first = service(baseDir, runtime);
  assert.equal((await first.service.status()).runtime.status, "not_installed");
  assert.equal(first.fetches(), 0, "nothing downloads before Install");
  await first.service.install();
  assert.equal((await first.service.status()).runtime.status, "installed");
  await first.service.signIn({
    signal: new AbortController().signal,
    notify: approveRedirect,
    prompt: (prompt) =>
      new Promise((_resolve, reject) => prompt.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
  });
  assert.equal((await first.service.status()).signedIn, true);
  await first.service.shutdown();

  // A fresh process: the first thing that happens is a chat turn.
  const second = service(baseDir, runtime);
  const host = new RecordingHost("chat-restart", tempDir());
  const unregister = acpHosts.register(host);
  try {
    const reply = await chat(second.service, "chat-restart", "echo:after restart");
    assert.equal(reply.stopReason, "stop", reply.errorMessage);
    const textBlock = reply.content.find((block) => block.type === "text");
    assert.equal(textBlock?.type === "text" ? textBlock.text : undefined, "after restart");

    // Removing the runtime and installing again keeps Antigravity usable.
    await second.service.removeRuntime();
    assert.equal((await second.service.status()).runtime.status, "not_installed");
    await second.service.install();
    const again = await chat(second.service, "chat-restart", "echo:reinstalled");
    assert.equal(again.stopReason, "stop", again.errorMessage);
  } finally {
    unregister();
    await second.service.shutdown();
  }
});

test("signing out clears the agent's own credentials", { skip: process.platform === "win32" }, async () => {
  const baseDir = tempDir();
  const runtime = fakeRuntime();
  const { service: target } = service(baseDir, runtime);
  await target.install();
  await target.signIn({
    signal: new AbortController().signal,
    notify: approveRedirect,
    prompt: (prompt) =>
      new Promise((_resolve, reject) => prompt.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
  });
  await target.signOut();
  assert.equal((await target.status()).signedIn, false);
  await target.shutdown();
});
