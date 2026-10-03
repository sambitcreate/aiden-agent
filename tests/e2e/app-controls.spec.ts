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
  await appearance.getByRole("combobox", { name: "Theme — This desktop", exact: true }).click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await expect(appearance.getByRole("status")).toContainText("Saved");
  expect(lmStudio.requests.length).toBe(modelRequests);
  await memorySwitch.click();
  await expect(memorySwitch).not.toBeChecked();
  expect(lmStudio.requests.length).toBe(modelRequests);
  await aiden.relaunch();
  const persisted = await aiden.page.evaluate(async () => {
    return (
      window as unknown as { aidenAPI: { ipc: { invoke<T>(channel: string): Promise<T> } } }
    ).aidenAPI.ipc.invoke<{ memoryEnabled: boolean; appearance: { mode: string } }>("settings:get");
  });
  expect(persisted.memoryEnabled).toBe(false);
  await expect(
    aiden.page
      .getByRole("region", { name: "memory controls" })
      .getByRole("switch", { name: "Memory — This desktop", exact: true }),
  ).not.toBeChecked();
  expect(persisted.appearance.mode).toBe("dark");
});
