import { expect, finishLmStudioOnboarding, test } from "./fixtures";

type Ipc = { invoke<T>(channel: string, ...args: unknown[]): Promise<T> };

test("a stop added in Settings → Agent Slider shows in the composer's slider and runs its model", async ({
  aiden,
}) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  // A second ready model to put on the new stop.
  await page.evaluate(async () => {
    const ipc = (window as unknown as { aidenAPI: { ipc: Ipc } }).aidenAPI.ipc;
    const providers = await ipc.invoke<{ id: string; models: string[] }[]>("providers:list");
    const lmStudioProvider = providers.find((provider) => provider.id === "custom:lmstudio")!;
    await ipc.invoke("providers:save", {
      ...lmStudioProvider,
      models: [...lmStudioProvider.models, "aiden-e2e-second"],
    });
  });
  await page.reload();
  await expect(page.locator("textarea")).toBeVisible();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("button", { name: "Agent Slider", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Agent Slider", exact: true }),
  ).toBeVisible();
  // Onboarding seeded Fast / Balanced / Smart around the connected model.
  await expect(page.getByRole("textbox", { name: /^Name of stop/u })).toHaveCount(3);

  // Add stop: a fourth "Choose a model" stop, its name field focused.
  await page.getByRole("button", { name: "Add stop", exact: true }).click();
  const name = page.getByRole("textbox", { name: "Name of stop 4" });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("Stop 4");
  await name.fill("Second");
  await name.press("Tab");
  await expect(page.getByText("Renamed the stop to “Second”", { exact: true })).toBeVisible();

  // Give it a model from the list.
  await page.getByRole("button", { name: "Choose a model for Second", exact: true }).click();
  await page
    .locator("[cmdk-item]")
    .filter({ hasText: /second/iu })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: /^Model for Second: .+\. Choose a model\.$/u }),
  ).toBeVisible();

  // Make it home; the preview rests there.
  await page.getByRole("radio", { name: "Home stop: Second", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Home stop: Second", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByRole("slider", { name: "Agent Slider" })).toHaveAttribute(
    "aria-valuenow",
    "4",
  );

  // The composer's popover shows the new stop, and Reset goes to the new home.
  await page.getByRole("button", { name: "Back to app" }).click();
  const modelPicker = page.getByRole("button", { name: /^Selected model:/u });
  await modelPicker.click();
  const agentSlider = page.getByRole("dialog", { name: "Choose agent" }).getByRole("slider", {
    name: "Agent Slider",
  });
  await expect(agentSlider).toHaveAttribute("aria-valuemax", "4");
  await page.locator('[data-agent-slider-stop="3"]').click();
  await expect(modelPicker).toHaveAttribute(
    "aria-label",
    /, Second on the Agent Slider\. Choose a model\.$/u,
  );
});
