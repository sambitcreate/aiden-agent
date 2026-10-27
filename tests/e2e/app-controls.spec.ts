import { appControlRevision } from "../../main/services/app-controls-core";
import type { AppSettings } from "../../main/services/types";
import { E2E_WORKSPACE_ID, expect, finishLmStudioOnboarding, test } from "./fixtures";

test.use({ workspaceSeed: true });

test("owned help and inert settings cards work with no workspace file access; clicks save without inference", async ({
  aiden,
}) => {
  const { page, lmStudio } = aiden;
  await finishLmStudioOnboarding(page);
  await page.evaluate(async (workspaceId) => {
    const ipc = (
      window as unknown as {
        aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } };
      }
    ).aidenAPI.ipc;
    await ipc.invoke("workspaces:update", workspaceId, { permission: "none" });
    await ipc.invoke("settings:set", {
      memoryEnabled: true,
      appControlPolicy: "safe",
      remoteAppControlsEnabled: false,
    });
  }, E2E_WORKSPACE_ID);
  const prompt =
    "App control test: explain Aiden memory and show its settings and appearance here.";
  const calls = [
    { name: "aiden_help", arguments: { query: "memory" } },
    { name: "aiden_show_controls", arguments: { topic: "memory" } },
    { name: "aiden_show_controls", arguments: { topic: "appearance" } },
  ];
  const scenario = lmStudio.enqueueToolScenario!({
    prompt,
    calls,
    finalText: "Your Aiden settings are below. Turning memory off keeps saved facts.",
  });
  await page.locator("textarea").first().fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  const memory = page.getByRole("region", { name: "memory controls" });
  await expect(memory).toBeVisible();
  const memorySwitch = memory.getByRole("switch", { name: "Memory — This desktop", exact: true });
  await expect(memorySwitch).toBeChecked();
  expect(scenario.error).toBeUndefined();
  expect(scenario.issuedToolNames).toEqual(calls.map(({ name }) => name));
  const modelRequests = lmStudio.requests.length;
  await memorySwitch.click();
  await expect(memorySwitch).not.toBeChecked();
  await expect(memory.getByRole("status")).toContainText("Saved");
  expect(lmStudio.requests.length).toBe(modelRequests);
  const settings = await page.evaluate(async () => {
    return (
      window as unknown as { aidenAPI: { ipc: { invoke<T>(channel: string): Promise<T> } } }
    ).aidenAPI.ipc.invoke<{ memoryEnabled: boolean; appearance?: { mode: string } }>(
      "settings:get",
    );
  });
  expect(settings.memoryEnabled).toBe(false);
  await memorySwitch.click();
  const confirmation = page.getByRole("dialog", { name: "Change Memory?" });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Apply change" }).click();
  await expect(memorySwitch).toBeChecked();
  expect(lmStudio.requests.length).toBe(modelRequests);
  const appearance = page.getByRole("region", { name: "appearance controls" });
  await appearance.getByRole("combobox", { name: "Color mode — This desktop", exact: true }).click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await expect(appearance.getByRole("status")).toContainText("Saved");
  // The open window repaints without visiting Settings → Appearance.
  await expect(page.locator("html")).toHaveAttribute("data-appearance-scheme", "dark");
  expect(lmStudio.requests.length).toBe(modelRequests);
  await memorySwitch.click();
  await expect(memorySwitch).not.toBeChecked();
  expect(lmStudio.requests.length).toBe(modelRequests);
  await aiden.relaunch();
  const persisted = await aiden.page.evaluate(async () => {
    return (
      window as unknown as { aidenAPI: { ipc: { invoke<T>(channel: string): Promise<T> } } }
    ).aidenAPI.ipc.invoke<AppSettings>("settings:get");
  });
  expect(persisted.memoryEnabled).toBe(false);
  await expect(
    aiden.page
      .getByRole("region", { name: "memory controls" })
      .getByRole("switch", { name: "Memory — This desktop", exact: true }),
  ).not.toBeChecked();
  expect(persisted.appearance?.mode).toBe("dark");
  await expect(aiden.page.locator("html")).toHaveAttribute("data-appearance-scheme", "dark");
  const themePrompt = "App control test: switch Aiden to light mode.";
  const theme = lmStudio.enqueueToolScenario!({
    prompt: themePrompt,
    calls: [
      {
        name: "aiden_set_preference",
        arguments: {
          control: "appearance.mode",
          value: "light",
          expectedRevision: appControlRevision({ settings: persisted }, "appearance.mode"),
          operationId: "e2e-theme-light",
        },
      },
    ],
    finalText: "Aiden is in light mode now.",
  });
  await aiden.page.locator("textarea").first().fill(themePrompt);
  await aiden.page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => theme.completed).toBe(true);
  expect(theme.error).toBeUndefined();
  expect(JSON.stringify(theme.results)).toContain("applied");
  // The chat window itself changes, not only the saved setting.
  await expect(aiden.page.locator("html")).toHaveAttribute("data-appearance-scheme", "light");
  const navigationPrompt = "App control test: open my provider settings.";
  const navigation = lmStudio.enqueueToolScenario!({
    prompt: navigationPrompt,
    calls: [{ name: "aiden_open", arguments: { destination: "providers" } }],
    finalText: "Opened provider settings.",
  });
  await aiden.page.locator("textarea").first().fill(navigationPrompt);
  await aiden.page.getByRole("button", { name: "Send message" }).click();
  await expect(aiden.page.getByRole("heading", { name: "Providers", exact: true })).toBeVisible();
  await expect.poll(() => navigation.completed).toBe(true);
  expect(navigation.error).toBeUndefined();
  expect(JSON.stringify(navigation.results)).toContain("opened");
  expect(JSON.stringify(navigation.results)).not.toContain("unavailable");
});

test("Aiden changes the color theme and the model for new chats from chat, and the app follows at once", async ({
  aiden,
}) => {
  const { page, lmStudio } = aiden;
  await finishLmStudioOnboarding(page);
  type Ipc = { invoke<T>(channel: string, ...args: unknown[]): Promise<T> };
  const settings = await page.evaluate(async () => {
    const ipc = (window as unknown as { aidenAPI: { ipc: Ipc } }).aidenAPI.ipc;
    await ipc.invoke("settings:set", { appControlPolicy: "safe" });
    // A second ready model so there is somewhere to switch to.
    const providers = await ipc.invoke<{ id: string; models: string[] }[]>("providers:list");
    const lmStudio = providers.find((provider) => provider.id === "custom:lmstudio")!;
    await ipc.invoke("providers:save", { ...lmStudio, models: [...lmStudio.models, "aiden-e2e-second"] });
    return ipc.invoke<AppSettings>("settings:get");
  });
  const prompt = "App control test: use the Moss theme and the second model for new chats.";
  const scenario = lmStudio.enqueueToolScenario!({
    prompt,
    calls: [
      {
        name: "aiden_set_preference",
        arguments: {
          control: "appearance.theme",
          value: "moss",
          expectedRevision: appControlRevision({ settings }, "appearance.theme"),
          operationId: "e2e-theme-moss",
        },
      },
      {
        name: "aiden_set_preference",
        arguments: {
          control: "models.newChat",
          value: "custom:lmstudio::aiden-e2e-second",
          expectedRevision: appControlRevision({ settings }, "models.newChat"),
          operationId: "e2e-new-chat-model",
        },
      },
    ],
    finalText: "Done: Moss theme, and new chats use the second model.",
  });
  await page.locator("textarea").first().fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => scenario.completed).toBe(true);
  expect(scenario.error).toBeUndefined();
  expect(JSON.stringify(scenario.results)).not.toContain("error");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "moss");
  // The window's own new-chat model follows, without a reload.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("aiden-agent.model")))
    .toBe("aiden-e2e-second");
  const saved = await page.evaluate(() =>
    (window as unknown as { aidenAPI: { ipc: Ipc } }).aidenAPI.ipc.invoke<AppSettings>("settings:get"),
  );
  expect(saved.lastModel).toBe("aiden-e2e-second");

  // A send in this chat, which keeps its own first model, leaves the new-chat model alone.
  const followUp = "App control test: thanks, one more question in this chat.";
  const reply = lmStudio.enqueueToolScenario!({ prompt: followUp, calls: [], finalText: "Sure." });
  await page.locator("textarea").first().fill(followUp);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => reply.completed).toBe(true);
  const after = await page.evaluate(() =>
    (window as unknown as { aidenAPI: { ipc: Ipc } }).aidenAPI.ipc.invoke<AppSettings>("settings:get"),
  );
  expect(after.lastModel).toBe("aiden-e2e-second");
  expect(await page.evaluate(() => localStorage.getItem("aiden-agent.model"))).toBe("aiden-e2e-second");
});
