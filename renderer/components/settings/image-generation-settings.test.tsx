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

async function openSetup(name: string) {
  fireEvent.click(await screen.findByRole("button", { name }));
  return screen.findByRole("dialog");
}

test("provider rows show key status and offer Set up or Manage by connection", async () => {
  mount();
  await screen.findByRole("button", { name: "Manage OpenRouter" });
  assert.ok(screen.getByText("Connected"));
  assert.ok(screen.getByText("Connected via environment"));
  assert.ok(screen.getByText("Not connected"));
  assert.ok(screen.getByRole("button", { name: "Set up Replicate" }));
  // An environment key still counts as connected.
  assert.ok(screen.getByRole("button", { name: "Manage fal" }));
  // fal lists two models; the fetched one is off.
  assert.ok(screen.getByText("2 models · 1 on"));
  // Key and fetch controls live in the dialog, not inline on the page.
  assert.equal(screen.queryByRole("button", { name: "Fetch latest OpenRouter models" }) === null, true);
});

test("Manage opens the provider dialog with its key and model list, and closing returns focus", async () => {
  mount();
  const trigger = await screen.findByRole("button", { name: "Manage OpenRouter" });
  const dialog = await openSetup("Manage OpenRouter");
  assert.match(dialog.textContent ?? "", /OpenRouter/u);
  assert.match(dialog.textContent ?? "", /encrypted on this Mac/u);
  assert.ok(within(dialog).getByText("Key saved"));
  assert.ok(within(dialog).getByRole("button", { name: "Replace OpenRouter key" }));
  assert.ok(within(dialog).getByRole("button", { name: "Remove OpenRouter key" }));
  assert.ok(within(dialog).getByRole("button", { name: "Fetch latest OpenRouter models" }));
  // A stored key is never echoed back as a field.
  assert.equal(within(dialog).queryByLabelText("OpenRouter image API key") === null, true);

  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => assert.equal(screen.queryByRole("dialog") === null, true));
  assert.equal(document.activeElement === trigger, true);
});

test("an environment key can't be removed from the dialog", async () => {
  mount();
  const dialog = await openSetup("Manage fal");
  assert.equal(within(dialog).queryByRole("button", { name: "Remove fal key" }) === null, true);
  assert.ok(within(dialog).getByLabelText("fal image API key"));
});

test("saving a key in the dialog sends it once, clears the field and shows the new status", async () => {
  const connected = baseState();
  connected.providers[1] = provider("replicate", { key: { connected: true, source: "stored" } });
  const calls = mount({ "imageGeneration:setKey": () => ok(connected) });
  const dialog = await openSetup("Set up Replicate");
  const field = within(dialog).getByLabelText("Replicate image API key") as HTMLInputElement;
  assert.equal(field.type, "password");
  fireEvent.change(field, { target: { value: "  r8_secret_token_value  " } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save key" }));
  await waitFor(() => assert.ok(within(dialog).getByText("Key saved")));
  assert.deepEqual(callsTo(calls, "imageGeneration:setKey"), [[{ provider: "replicate", key: "r8_secret_token_value" }]]);
  assert.equal(within(dialog).queryByLabelText("Replicate image API key") === null, true);
  assert.equal(document.body.textContent?.includes("r8_secret_token_value"), false);
  // Replace opens an empty field again.
  fireEvent.click(within(dialog).getByRole("button", { name: "Replace Replicate key" }));
  assert.equal((within(dialog).getByLabelText("Replicate image API key") as HTMLInputElement).value, "");
});

test("a rejected key keeps the field open and shows the reason", async () => {
  mount({
    "imageGeneration:setKey": () => ({ ok: false, code: "invalid_key", message: "That key looks too short." }),
  });
  const dialog = await openSetup("Set up Replicate");
  fireEvent.change(within(dialog).getByLabelText("Replicate image API key"), { target: { value: "short-ish" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save key" }));
  assert.equal((await within(dialog).findByRole("alert")).textContent, "That key looks too short.");
  assert.ok(within(dialog).getByLabelText("Replicate image API key"));
});

test("removing a key asks for confirmation before calling removeKey", async () => {
  const removed = baseState();
  removed.providers[0] = provider("openrouter");
  const calls = mount({ "imageGeneration:removeKey": () => ok(removed) });
  const dialog = await openSetup("Manage OpenRouter");
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove OpenRouter key" }));
  const confirm = await screen.findByRole("alertdialog");
  assert.ok(within(confirm).getByText("Remove the OpenRouter image key?"));
  assert.deepEqual(callsTo(calls, "imageGeneration:removeKey"), []);
  fireEvent.click(within(confirm).getByRole("button", { name: "Remove key" }));
  await waitFor(() =>
    assert.deepEqual(callsTo(calls, "imageGeneration:removeKey"), [[{ provider: "openrouter" }]]),
  );
  // The dialog now offers a fresh key field.
  await waitFor(() => assert.ok(within(dialog).getByLabelText("OpenRouter image API key")));
});

test("Replicate's fetch needs a key; other providers fetch and report the count", async () => {
  const fetched = baseState();
  fetched.providers[0] = provider("openrouter", {
    key: { connected: true, source: "stored" },
    fetchedAt: Date.now(),
    fetchedCount: 42,
  });
  const calls = mount({ "imageGeneration:fetchModels": () => ok(fetched) });
  const replicateDialog = await openSetup("Set up Replicate");
  const replicate = within(replicateDialog).getByRole("button", {
    name: "Fetch latest Replicate models",
  }) as HTMLButtonElement;
  assert.equal(replicate.disabled, true);
  assert.match(
    document.getElementById(replicate.getAttribute("aria-describedby") ?? "")?.textContent ?? "",
    /Add a Replicate key/u,
  );
  fireEvent.keyDown(replicateDialog, { key: "Escape" });
  await waitFor(() => assert.equal(screen.queryByRole("dialog") === null, true));

  const dialog = await openSetup("Manage OpenRouter");
  fireEvent.click(within(dialog).getByRole("button", { name: "Fetch latest OpenRouter models" }));
  assert.ok(await within(dialog).findByText(/Fetched 42 models/u));
  assert.ok(within(dialog).getByText(/Last fetched .* · 42 models/u));
  assert.deepEqual(callsTo(calls, "imageGeneration:fetchModels"), [[{ provider: "openrouter" }]]);
});

test("a failed fetch shows the provider's message inline", async () => {
  mount({
    "imageGeneration:fetchModels": () => ({ ok: false, code: "network_error", message: "fal didn’t respond." }),
  });
  const dialog = await openSetup("Manage fal");
  fireEvent.click(within(dialog).getByRole("button", { name: "Fetch latest fal models" }));
  assert.equal((await within(dialog).findByRole("alert")).textContent, "fal didn’t respond.");
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

test("a running fetch locks only that provider's fetch, not its key controls or other providers", async () => {
  let finish!: (result: ImageGenerationActionResult) => void;
  const calls = mount({
    "imageGeneration:fetchModels": (request) =>
      (request as { provider: string }).provider === "openrouter"
        ? new Promise<ImageGenerationActionResult>((resolve) => {
            finish = resolve;
          })
        : ok(baseState()),
  });
  const dialog = await openSetup("Manage OpenRouter");
  const button = (name: string) => within(dialog).getByRole("button", { name }) as HTMLButtonElement;
  fireEvent.click(button("Fetch latest OpenRouter models"));
  await waitFor(() => assert.ok(within(dialog).getByText("Fetching…")));
  assert.equal(button("Fetch latest OpenRouter models").disabled, true);
  assert.equal(button("Replace OpenRouter key").disabled, false);
  assert.equal(button("Remove OpenRouter key").disabled, false);
  // A second click on the running fetch is not a second request.
  fireEvent.click(button("Fetch latest OpenRouter models"));

  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => assert.equal(screen.queryByRole("dialog") === null, true));
  const fal = await openSetup("Manage fal");
  const falFetch = within(fal).getByRole("button", { name: "Fetch latest fal models" }) as HTMLButtonElement;
  assert.equal(falFetch.disabled, false);
  fireEvent.click(falFetch);
  await waitFor(() =>
    assert.deepEqual(callsTo(calls, "imageGeneration:fetchModels"), [
      [{ provider: "openrouter" }],
      [{ provider: "fal" }],
    ]),
  );
  finish(ok(baseState()));
});

async function chooseBulk(label: RegExp) {
  fireEvent.keyDown(await screen.findByRole("button", { name: "Bulk actions for listed models" }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: label }));
}

test("Turn on all listed sends exactly the filtered rows that change, in one call", async () => {
  const state = baseState();
  state.models = [
    model({ provider: "openrouter", id: "google/gemini-3.1-flash-image", name: "Nano Banana 2", enabled: false }),
    model({ provider: "fal", id: "fal-ai/seedream/v4", name: "Seedream 4", enabled: false }),
    model({ provider: "fal", id: "fal-ai/flux/schnell", name: "FLUX Schnell", enabled: true }),
    model({ provider: "fal", id: "fal-ai/recraft", name: "Recraft", enabled: false, origin: "custom" }),
    model({ provider: "fal", id: "fal-ai/obscure-model", name: "Obscure Fetched", enabled: false, origin: "fetched" }),
  ];
  const calls = mount({ "imageGeneration:setModelsEnabled": () => ok(state) }, state);
  fireEvent.click(await screen.findByRole("button", { name: "fal" }));
  await chooseBulk(/^Turn on all listed/u);
  await waitFor(() => assert.equal(callsTo(calls, "imageGeneration:setModelsEnabled").length, 1));
  // Only fal rows that are listed (the hidden fetched one is not) and currently off.
  assert.deepEqual(callsTo(calls, "imageGeneration:setModelsEnabled"), [
    [
      {
        changes: [
          { provider: "fal", id: "fal-ai/seedream/v4", enabled: true },
          { provider: "fal", id: "fal-ai/recraft", enabled: true },
        ],
      },
    ],
  ]);
  assert.ok(await screen.findByText("Turned on 2 models."));
  assert.deepEqual(callsTo(calls, "imageGeneration:setModelEnabled"), []);
});

test("Only providers with a key turns on connected providers' rows and turns off the rest", async () => {
  const state = baseState();
  state.models = [
    model({ provider: "openrouter", id: "google/gemini-3.1-flash-image", name: "Nano Banana 2", enabled: false }),
    model({ provider: "replicate", id: "black-forest-labs/flux-2-pro", name: "FLUX.2 Pro", enabled: true }),
    model({ provider: "replicate", id: "google/imagen-4-fast", name: "Imagen 4 Fast", enabled: false }),
    model({ provider: "fal", id: "fal-ai/seedream/v4", name: "Seedream 4", enabled: true }),
  ];
  const calls = mount({ "imageGeneration:setModelsEnabled": () => ok(state) }, state);
  await chooseBulk(/^Only providers with a key/u);
  await waitFor(() =>
    assert.deepEqual(callsTo(calls, "imageGeneration:setModelsEnabled"), [
      [
        {
          changes: [
            { provider: "openrouter", id: "google/gemini-3.1-flash-image", enabled: true },
            { provider: "replicate", id: "black-forest-labs/flux-2-pro", enabled: false },
          ],
        },
      ],
    ]),
  );
  assert.ok(await screen.findByText("Turned on 1 model and turned off 1 model."));
});

test("bulk items that would change nothing are disabled", async () => {
  mount();
  // Every listed model in the base state is already on.
  fireEvent.keyDown(await screen.findByRole("button", { name: "Bulk actions for listed models" }), {
    key: "Enter",
  });
  const item = await screen.findByRole("menuitem", { name: /^Turn on all listed/u });
  assert.equal(item.getAttribute("aria-disabled"), "true");
  assert.equal(
    screen.getByRole("menuitem", { name: /^Turn off all listed/u }).getAttribute("aria-disabled") === "true",
    false,
  );
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
