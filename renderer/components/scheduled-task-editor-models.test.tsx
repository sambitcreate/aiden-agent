import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { installBotTestIpc } from "../main/bots/test-dom";
import { createBotTestQueryClient } from "../main/bots/test-providers";
import type { Provider, ScheduledTaskInput } from "../lib/types";
import { ScheduledTaskEditor } from "./scheduled-task-editor";

let queryClient: QueryClient | undefined;
afterEach(() => {
  cleanup();
  queryClient?.clear();
});

const providers = [
  {
    id: "zai-coding-cn",
    kind: "openai",
    label: "Z.AI Coding CN",
    models: ["glm-5.3", "glm-5.3-flash"],
    needsKey: true,
    hasKey: true,
    isBuiltin: true,
  },
  {
    id: "anthropic",
    kind: "openai",
    label: "Anthropic",
    models: ["claude-opus-4-1"],
    needsKey: true,
    hasKey: true,
    isBuiltin: true,
  },
] as unknown as Provider[];

const task: ScheduledTaskInput = {
  name: "Morning brief",
  enabled: true,
  mode: "llm",
  cron: "0 9 * * 1-5",
  timezone: "UTC",
  providerId: "zai-coding-cn",
  model: "glm-5.3",
  prompt: "Summarize my day.",
  script: "",
  permission: "read-only",
  mcpServerIds: [],
  webSearchEnabled: false,
  notify: true,
};

function mount() {
  installBotTestIpc({
    "schedule:preview": () => [],
    "schedule:scripts": () => [],
    // The device-local catalog knows one model's official name; the other is named from its id.
    "models:info": (providerId: unknown) =>
      providerId === "zai-coding-cn" ? { "glm-5.3": { name: "GLM-5.3" } } : {},
  });
  queryClient = createBotTestQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <ScheduledTaskEditor
        open
        initial={task}
        workspaces={[]}
        mcpServers={[]}
        providers={providers}
        busy={false}
        onOpenChange={() => {}}
        onSave={async () => {}}
      />
    </QueryClientProvider>,
  );
}

async function openSelect(name: string) {
  const trigger = await screen.findByRole("combobox", { name });
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  return screen.findByRole("listbox");
}

test("the provider and model choices show each provider's logo, and models read by the names the chat model picker uses", async () => {
  mount();
  const providerTrigger = await screen.findByRole("combobox", {
    name: "Scheduled task provider",
  });
  assert.ok(
    providerTrigger.querySelector('[data-provider-icon="zai-coding-cn"]'),
    "the chosen provider shows its logo",
  );
  const modelTrigger = screen.getByRole("combobox", {
    name: "Scheduled task model",
  });
  await waitFor(() => assert.equal(modelTrigger.textContent, "GLM-5.3"));

  const models = await openSelect("Scheduled task model");
  const labels = within(models)
    .getAllByRole("option")
    .map((option) => option.textContent);
  assert.deepEqual(labels, ["GLM-5.3", "GLM 5.3 Flash"]);
  assert.equal(
    within(models)
      .getAllByRole("option")
      .every((option) => option.querySelector('[data-provider-icon="zai-coding-cn"]')),
    true,
  );
  fireEvent.keyDown(models, { key: "Escape" });

  const choices = await openSelect("Scheduled task provider");
  const anthropic = within(choices).getByRole("option", { name: /Anthropic/u });
  assert.ok(anthropic.querySelector('[data-provider-icon="anthropic"]'));
});
