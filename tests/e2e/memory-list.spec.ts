import { expect, finishLmStudioOnboarding, test } from "./fixtures";

test.use({ workspaceSeed: true });

test("a fact Aiden saves in chat shows in Settings → Memory and can be deleted for good", async ({
  aiden,
}) => {
  const { page, lmStudio } = aiden;
  await finishLmStudioOnboarding(page);
  await page.evaluate(async () => {
    await (
      window as unknown as {
        aidenAPI: { ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } };
      }
    ).aidenAPI.ipc.invoke("settings:set", { memoryEnabled: true });
  });
  const openMemory = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Settings" })
      .getByRole("button", { name: "Memory", exact: true })
      .click();
  };
  const remembered = page.locator("section", {
    has: page.getByRole("heading", { name: "What Aiden remembers", exact: true }),
  });
  // Read the list once before the fact exists, so the return visit has to read it again.
  await openMemory();
  await expect(remembered.getByText("Aiden hasn't saved anything in this workspace yet.")).toBeVisible();
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await page.getByRole("button", { name: "New Agent", exact: true }).click();

  const fact = "The release branch in this project is called stable.";
  const prompt = "Memory list test: remember that our release branch is called stable.";
  const scenario = lmStudio.enqueueToolScenario!({
    prompt,
    calls: [{ name: "remember_fact", arguments: { fact } }],
    finalText: "Saved. I'll remember the release branch is called stable.",
  });
  await page.locator("textarea").first().fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect.poll(() => scenario.completed).toBe(true);
  expect(scenario.error).toBeUndefined();
  expect(JSON.stringify(scenario.results)).toContain("Saved approved fact");

  await openMemory();
  await expect(remembered.getByText(fact, { exact: true })).toBeVisible();
  await expect(remembered.getByText(/Saved by Aiden/u)).toBeVisible();

  await remembered.getByRole("button", { name: `Delete memory: ${fact}` }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete this memory?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(remembered.getByText("Aiden hasn't saved anything in this workspace yet.")).toBeVisible();
  await expect(remembered.getByText(fact, { exact: true })).toHaveCount(0);

  await aiden.relaunch();
  const facts = await aiden.page.evaluate(async () => {
    const ipc = (
      window as unknown as {
        aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } };
      }
    ).aidenAPI.ipc;
    const workspaces = await ipc.invoke<{ id: string }[]>("workspaces:list");
    return Promise.all(
      workspaces.map((workspace) =>
        ipc.invoke<{ text: string }[]>("workspaces:memoryFacts", workspace.id),
      ),
    );
  });
  expect(facts.flat().map(({ text }) => text)).not.toContain(fact);
});
