import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installBotTestIpc, type BotTestIpcCall } from "../../main/bots/test-dom";
import { ImageGenerationSettings } from "./image-generation-settings";
import type {
  ImageGenerationActionResult,
  ImageGenerationModelView,
  ImageGenerationProviderView,
  ImageGenerationState,
} from "../../shared/image-generation/types";

afterEach(cleanup);

function provider(
  id: ImageGenerationProviderView["id"],
  patch: Partial<ImageGenerationProviderView> = {},
): ImageGenerationProviderView {
  const names = { openrouter: "OpenRouter", replicate: "Replicate", fal: "fal" } as const;
  return {
    id,
    name: names[id],
    key: { connected: false, source: null },
    fetchedAt: null,
    fetchedCount: 0,
    fetchRequiresKey: id === "replicate",
    ...patch,
  };
}

function model(patch: Partial<ImageGenerationModelView> & Pick<ImageGenerationModelView, "provider" | "id" | "name">): ImageGenerationModelView {
  return { acceptsReferenceImages: false, enabled: true, origin: "curated", ...patch };
}

function baseState(): ImageGenerationState {
  return {
    providers: [
      provider("openrouter", { key: { connected: true, source: "stored" } }),
      provider("replicate"),
      provider("fal", { key: { connected: true, source: "env" } }),
    ],
    models: [
      model({ provider: "openrouter", id: "google/gemini-3.1-flash-image", name: "Nano Banana 2", acceptsReferenceImages: true }),
      model({ provider: "replicate", id: "black-forest-labs/flux-2-pro", name: "FLUX.2 Pro" }),
      model({ provider: "fal", id: "fal-ai/seedream/v4", name: "Seedream 4" }),
      model({ provider: "fal", id: "fal-ai/obscure-model", name: "Obscure Fetched", enabled: false, origin: "fetched" }),
    ],
    defaultModel: null,
  };
}

const ok = (state: ImageGenerationState): ImageGenerationActionResult => ({ ok: true, state });

function mount(handlers: Record<string, (...args: unknown[]) => unknown> = {}, state = baseState()) {
  const calls = installBotTestIpc({ "imageGeneration:state": () => state, ...handlers });
  render(<ImageGenerationSettings />);
  return calls;
}

const callsTo = (calls: BotTestIpcCall[], channel: string) =>
  calls.filter((call) => call.channel === channel).map((call) => call.args);

test("each provider shows its key status without ever showing a key", async () => {
  mount();
  assert.ok(await screen.findByRole("group", { name: /OpenRouter\s*Connected$/u }));
  assert.ok(screen.getByText("Connected"));
  assert.ok(screen.getByText("Connected via environment"));
  assert.ok(screen.getByText("Not connected"));
  // Only a stored key can be removed; the environment key is outside Aiden's control.
  assert.ok(screen.getByRole("button", { name: "Remove OpenRouter key" }));
  assert.equal(screen.queryByRole("button", { name: "Remove fal key" }) === null, true);
  assert.ok(screen.getByRole("button", { name: "Replace OpenRouter key" }));
  assert.ok(screen.getByRole("button", { name: "Add Replicate key" }));
});

test("saving a key sends it once, clears the field and shows the new status", async () => {
  const connected = baseState();
  connected.providers[1] = provider("replicate", { key: { connected: true, source: "stored" } });
  const calls = mount({ "imageGeneration:setKey": () => ok(connected) });
  fireEvent.click(await screen.findByRole("button", { name: "Add Replicate key" }));
  const field = screen.getByLabelText("Replicate image API key") as HTMLInputElement;
  assert.equal(field.type, "password");
  fireEvent.change(field, { target: { value: "  r8_secret_token_value  " } });
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Remove Replicate key" })));
  assert.deepEqual(callsTo(calls, "imageGeneration:setKey"), [[{ provider: "replicate", key: "r8_secret_token_value" }]]);
  assert.equal(screen.queryByLabelText("Replicate image API key") === null, true);
  assert.equal(document.body.textContent?.includes("r8_secret_token_value"), false);
});

test("a rejected key keeps the editor open and shows the reason", async () => {
  mount({
    "imageGeneration:setKey": () => ({ ok: false, code: "invalid_key", message: "That key looks too short." }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Add Replicate key" }));
  fireEvent.change(screen.getByLabelText("Replicate image API key"), { target: { value: "short-ish" } });
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  assert.equal((await screen.findByRole("alert")).textContent, "That key looks too short.");
  assert.ok(screen.getByLabelText("Replicate image API key"));
});

test("removing a key asks for confirmation before calling removeKey", async () => {
  const removed = baseState();
  removed.providers[0] = provider("openrouter");
  const calls = mount({ "imageGeneration:removeKey": () => ok(removed) });
  fireEvent.click(await screen.findByRole("button", { name: "Remove OpenRouter key" }));
  const dialog = await screen.findByRole("alertdialog");
  assert.ok(within(dialog).getByText("Remove the OpenRouter image key?"));
  assert.deepEqual(callsTo(calls, "imageGeneration:removeKey"), []);
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove key" }));
  await waitFor(() =>
    assert.deepEqual(callsTo(calls, "imageGeneration:removeKey"), [[{ provider: "openrouter" }]]),
  );
  await waitFor(() => assert.equal(screen.getAllByText("Not connected").length, 2));
});

test("Replicate's fetch needs a key; other providers fetch and report the count", async () => {
  const fetched = baseState();
  fetched.providers[0] = provider("openrouter", {
    key: { connected: true, source: "stored" },
    fetchedAt: Date.now(),
    fetchedCount: 42,
  });
  const calls = mount({ "imageGeneration:fetchModels": () => ok(fetched) });
  const replicate = (await screen.findByRole("button", {
    name: "Fetch latest Replicate models",
  })) as HTMLButtonElement;
  assert.equal(replicate.disabled, true);
  assert.match(replicate.getAttribute("aria-describedby") ?? "", /.+/u);
  assert.match(
    document.getElementById(replicate.getAttribute("aria-describedby")!)?.textContent ?? "",
    /Add a Replicate key/u,
  );
  fireEvent.click(screen.getByRole("button", { name: "Fetch latest OpenRouter models" }));
  assert.match((await screen.findByText(/Fetched 42 models/u)).textContent ?? "", /42/u);
  assert.ok(screen.getByText(/Last fetched .* · 42 models/u));
  assert.deepEqual(callsTo(calls, "imageGeneration:fetchModels"), [[{ provider: "openrouter" }]]);
});

test("a failed fetch shows the provider's message inline", async () => {
  mount({
    "imageGeneration:fetchModels": () => ({ ok: false, code: "network_error", message: "fal didn’t respond." }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Fetch latest fal models" }));
  assert.equal((await screen.findByRole("alert")).textContent, "fal didn’t respond.");
});

test("toggling a model calls setModelEnabled and adopts the returned state", async () => {
  const toggled = baseState();
  toggled.models[1] = { ...toggled.models[1]!, enabled: false };
  const calls = mount({ "imageGeneration:setModelEnabled": () => ok(toggled) });
  const toggle = await screen.findByRole("switch", { name: "Use FLUX.2 Pro" });
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  fireEvent.click(toggle);
  await waitFor(() =>
    assert.equal(screen.getByRole("switch", { name: "Use FLUX.2 Pro" }).getAttribute("aria-checked"), "false"),
  );
  assert.deepEqual(callsTo(calls, "imageGeneration:setModelEnabled"), [
    [{ provider: "replicate", id: "black-forest-labs/flux-2-pro", enabled: false }],
  ]);
});

test("search and the provider filter narrow the rows; fetched models that are off stay hidden until searched", async () => {
  mount();
  const list = await screen.findByRole("list", { name: "Image models" });
  const names = () =>
    within(list)
      .queryAllByRole("switch")
      .map((element) => element.getAttribute("aria-label"));
  assert.deepEqual(names(), ["Use Nano Banana 2", "Use FLUX.2 Pro", "Use Seedream 4"]);
  assert.ok(screen.getByText(/1 more from Fetch latest is off/u));
  assert.ok(within(list).getByText("Reference images"));

  fireEvent.change(screen.getByRole("searchbox", { name: "Search image models" }), {
    target: { value: "obscure" },
  });
  assert.deepEqual(names(), ["Use Obscure Fetched"]);

  fireEvent.change(screen.getByRole("searchbox", { name: "Search image models" }), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "fal" }));
  assert.deepEqual(names(), ["Use Seedream 4"]);

  fireEvent.change(screen.getByRole("searchbox", { name: "Search image models" }), {
    target: { value: "nothing-like-this" },
  });
  assert.ok(screen.getByText("No image models match “nothing-like-this”."));
});

test("adding a model by ID surfaces the main process's error", async () => {
  const calls = mount({
    "imageGeneration:addCustomModel": () => ({
      ok: false,
      code: "invalid_request",
      message: "Enter an OpenRouter model id such as vendor/model.",
    }),
  });
  fireEvent.change(await screen.findByLabelText("Model ID"), { target: { value: "not-a-model" } });
  fireEvent.click(screen.getByRole("button", { name: "Add model" }));
  assert.equal(
    (await screen.findByRole("alert")).textContent,
    "Enter an OpenRouter model id such as vendor/model.",
  );
  assert.deepEqual(callsTo(calls, "imageGeneration:addCustomModel"), [
    [{ provider: "openrouter", id: "not-a-model" }],
  ]);
  assert.equal((screen.getByLabelText("Model ID") as HTMLInputElement).value, "not-a-model");
});

test("custom models can be removed from their row", async () => {
  const state = baseState();
  state.models.push(model({ provider: "openrouter", id: "acme/painter", name: "Painter", origin: "custom" }));
  const calls = mount({ "imageGeneration:removeCustomModel": () => ok(baseState()) }, state);
  assert.ok(await screen.findByText(/Added by you/u));
  fireEvent.click(screen.getByRole("button", { name: "Remove Painter" }));
  // Compare booleans: a failing assert on a DOM node would try to print the whole tree.
  await waitFor(() =>
    assert.equal(screen.queryByRole("switch", { name: "Use Painter" }) === null, true),
  );
  assert.deepEqual(callsTo(calls, "imageGeneration:removeCustomModel"), [
    [{ provider: "openrouter", id: "acme/painter" }],
  ]);
});

test("a running fetch locks only that provider's fetch, not key controls or other providers", async () => {
  let finish!: (result: ImageGenerationActionResult) => void;
  const calls = mount({
    "imageGeneration:fetchModels": () =>
      new Promise<ImageGenerationActionResult>((resolve) => {
        finish = resolve;
      }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Fetch latest OpenRouter models" }));
  await waitFor(() => assert.ok(screen.getByText("Fetching…")));
  const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
  assert.equal(button("Fetch latest OpenRouter models").disabled, true);
  assert.equal(button("Fetch latest fal models").disabled, false);
  assert.equal(button("Replace OpenRouter key").disabled, false);
  assert.equal(button("Remove OpenRouter key").disabled, false);
  assert.equal(button("Add Replicate key").disabled, false);
  assert.equal((screen.getByRole("switch", { name: "Use FLUX.2 Pro" }) as HTMLButtonElement).disabled, false);

  // A second click on the running fetch is not a second request.
  fireEvent.click(button("Fetch latest OpenRouter models"));
  fireEvent.click(button("Fetch latest fal models"));
  await waitFor(() =>
    assert.deepEqual(callsTo(calls, "imageGeneration:fetchModels"), [
      [{ provider: "openrouter" }],
      [{ provider: "fal" }],
    ]),
  );
  finish(ok(baseState()));
});

test("switching two different models in quick succession sends both changes", async () => {
  const resolvers: (() => void)[] = [];
  const calls = mount({
    "imageGeneration:setModelEnabled": () =>
      new Promise<ImageGenerationActionResult>((resolve) => {
        resolvers.push(() => resolve(ok(baseState())));
      }),
  });
  fireEvent.click(await screen.findByRole("switch", { name: "Use FLUX.2 Pro" }));
  fireEvent.click(screen.getByRole("switch", { name: "Use Seedream 4" }));
  await waitFor(() =>
    assert.deepEqual(callsTo(calls, "imageGeneration:setModelEnabled"), [
      [{ provider: "replicate", id: "black-forest-labs/flux-2-pro", enabled: false }],
      [{ provider: "fal", id: "fal-ai/seedream/v4", enabled: false }],
    ]),
  );
  for (const resolve of resolvers) resolve();
});
