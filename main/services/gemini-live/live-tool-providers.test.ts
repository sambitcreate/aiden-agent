import assert from "node:assert/strict";
import test from "node:test";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import { prepareLiveToolProviders } from "./live-tool-providers.js";
import { LiveRendererToolBroker, type LiveToolProvider } from "./live-tools.js";

function input(signal = new AbortController().signal) {
  return {
    owner: {} as RendererDocumentOwner,
    sessionId: "s1",
    signal,
    renderer: new LiveRendererToolBroker("s1", () => undefined),
  };
}

function provider(name: string, closed: string[] = []): LiveToolProvider {
  return {
    declarations: [{ name, description: name }],
    handle: async () => ({ ok: true }),
    close: () => closed.push(name),
  };
}

test("a feature whose switch is off or whose setup fails leaves only its own tools out", async () => {
  const providers = await prepareLiveToolProviders(input(), {}, [
    () => provider("read_open_chat"),
    () => null,
    () => {
      throw new Error("setup failed");
    },
    async (_input, settings) => (settings.aidenLiveAppControl === false ? null : provider("look_at_aiden")),
  ]);
  assert.deepEqual(
    providers.map((entry) => entry.declarations[0]!.name),
    ["read_open_chat", "look_at_aiden"],
  );
});

test("a start cancelled while tools are prepared closes what was built and returns none", async () => {
  const abort = new AbortController();
  const closed: string[] = [];
  const providers = await prepareLiveToolProviders(input(abort.signal), {}, [
    () => provider("read_open_chat", closed),
    () => {
      abort.abort();
      return provider("end_session", closed);
    },
    () => provider("look_at_aiden", closed),
  ]);
  assert.deepEqual(providers, []);
  assert.deepEqual(closed, ["read_open_chat", "end_session"]);
});
