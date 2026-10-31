import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../lib/queries";
import type { Provider } from "../../lib/types";
import type { BotCapabilityCatalog } from "../../shared/bot-capabilities";
import { catalogFixture } from "./test-fixtures";
import { createBotTestQueryClient } from "./test-providers";
import { BotModelPicker } from "./bot-model-picker";

afterEach(cleanup);

function catalog(): BotCapabilityCatalog {
  const base = catalogFixture();
  return {
    ...base,
    providers: [
      ...base.providers,
      {
        id: "prov-off",
        label: "Signed Out",
        available: false,
        models: [{ id: "model-off", label: "Ghost", available: true, supportsImages: true }],
      },
    ],
  };
}

let queryClient: QueryClient | undefined;
afterEach(() => queryClient?.clear());

function mount(
  props: Partial<React.ComponentProps<typeof BotModelPicker>> = {},
  providers: Provider[] = [],
) {
  const picks: string[] = [];
  queryClient = createBotTestQueryClient();
  queryClient.setQueryData(queryKeys.providers, providers);
  render(
    <QueryClientProvider client={queryClient}>
      <BotModelPicker
        catalog={props.catalog ?? catalog()}
        label="AI model"
        providerId="prov-text"
        modelId="model-text"
        recommended={{ providerId: "prov-text", modelId: "model-text" }}
        onSelect={(providerId, modelId) => picks.push(`${providerId}/${modelId}`)}
        {...props}
      />
    </QueryClientProvider>,
  );
  return picks;
}

test("the trigger names only the model, and marks the recommended one", () => {
  mount();
  const trigger = screen.getByRole("button", { name: "AI model" });
  assert.match(trigger.textContent ?? "", /Writer/u);
  assert.match(trigger.textContent ?? "", /Recommended/u);
  assert.doesNotMatch(trigger.textContent ?? "", /Text only|Reads images/u);
});

test("models are grouped by service; choosing one reports it and closes, unusable ones can't be chosen", async () => {
  const picks = mount();
  fireEvent.click(screen.getByRole("button", { name: "AI model" }));
  assert.ok(await screen.findByText("Vision Service"));
  assert.ok(screen.getByText("Signed Out · Not set up"));

  const ghost = screen.getByRole("option", { name: /^Ghost/u });
  assert.equal(ghost.getAttribute("aria-disabled"), "true");
  fireEvent.click(ghost);
  assert.deepEqual(picks, []);

  fireEvent.click(screen.getByRole("option", { name: /^Seer/u }));
  assert.deepEqual(picks, ["prov-vision/model-vision"]);
  assert.equal(screen.queryByRole("option", { name: /^Seer/u }), null);
});

test("each option says whether the model reads images, and the current model is marked selected", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "AI model" }));
  const writer = await screen.findByRole("option", { name: /^Writer/u });
  const seer = screen.getByRole("option", { name: /^Seer/u });
  assert.match(writer.textContent ?? "", /Text only/u);
  assert.match(seer.textContent ?? "", /Reads images/u);
  assert.ok(within(writer).getByRole("img", { name: "Selected" }));
  assert.equal(within(seer).queryByRole("img", { name: "Selected" }) === null, true);
});

test("the photo picker lists only models that read images", async () => {
  mount({ label: "Model for photos", imagesOnly: true, providerId: "prov-vision", modelId: "model-vision" });
  fireEvent.click(screen.getByRole("button", { name: "Model for photos" }));
  assert.ok(await screen.findByRole("option", { name: /^Seer/u }));
  assert.equal(screen.queryByRole("option", { name: /^Writer/u }), null);
});

test("typing filters the list", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "AI model" }));
  fireEvent.change(await screen.findByRole("combobox", { name: "Filter models" }), { target: { value: "seer" } });
  await waitFor(() => assert.equal(screen.queryByRole("option", { name: /^Writer/u }) === null, true));
  assert.ok(screen.getByRole("option", { name: /^Seer/u }));
});

test("each model shows the same mark as the chat model picker, found from the opaque catalog by the service's name", async () => {
  const base = catalogFixture();
  const artwork = { mimeType: "image/png", dataBase64: "iVBORw0KGgo=" } as const;
  // Production Bot catalogs carry main-minted opaque ids, never provider or model ids.
  mount(
    {
      catalog: {
        ...base,
        providers: [
          {
            id: "bc_provider_7f3a",
            label: "Anthropic",
            available: true,
            models: [{ id: "bc_model_19c2", label: "Claude Opus 4.1", available: true, supportsImages: true }],
          },
          {
            id: "bc_provider_d041",
            label: "Studio Box",
            available: true,
            models: [{ id: "bc_model_5e8b", label: "Local Model", available: true, supportsImages: false }],
          },
          {
            id: "bc_provider_aa90",
            label: "Twin Box",
            available: true,
            models: [{ id: "bc_model_0b17", label: "Twin Model", available: true, supportsImages: false }],
          },
        ],
      },
      providerId: "bc_provider_7f3a",
      modelId: "bc_model_19c2",
      recommended: undefined,
    },
    [
      { id: "anthropic", label: "Anthropic" } as unknown as Provider,
      { id: "custom:studio", label: "Studio Box", artwork } as unknown as Provider,
      // Two connections share a name, so neither can be told apart from the catalog.
      { id: "openai", label: "Twin Box" } as unknown as Provider,
      { id: "custom:twin", label: "Twin Box", artwork } as unknown as Provider,
    ],
  );
  const trigger = screen.getByRole("button", { name: "AI model" });
  await waitFor(() => assert.ok(trigger.querySelector('[data-provider-icon="claude"]'), "the trigger shows the Claude mark"));
  fireEvent.click(trigger);
  const claude = await screen.findByRole("option", { name: /^Claude Opus 4\.1/u });
  const local = screen.getByRole("option", { name: /^Local Model/u });
  const twin = screen.getByRole("option", { name: /^Twin Model/u });
  assert.ok(claude.querySelector('[data-provider-icon="claude"]'), "a Claude model shows the Claude mark");
  assert.ok(local.querySelector('[data-provider-icon="custom"]'), "a custom connection shows its picture");
  assert.equal(twin.querySelector("[data-provider-icon]"), null, "an ambiguous name never borrows another service's mark");
  assert.ok(twin.querySelector("[data-provider-icon-fallback]"), "an ambiguous name keeps the neutral initial");
});
