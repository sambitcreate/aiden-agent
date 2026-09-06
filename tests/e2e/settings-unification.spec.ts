import { expect, finishLmStudioOnboarding, test } from "./fixtures";

test.use({ workspaceSeed: true });

test("disabling Skills removes hidden instructions from the next provider request", async ({
  aiden,
}) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await page.evaluate(async () => {
    const { ipc } = (
      window as unknown as {
        aidenAPI: { ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } };
      }
    ).aidenAPI;
    await ipc.invoke("skills:save", {
      id: "skills-off-fixture",
      name: "Review fixture",
      description: "A deterministic review skill",
      instructions: "PRIVATE_SKILL_INSTRUCTION_MARKER: Review the supplied code.",
      enabled: true,
    });
  });
  await page.reload();
  const composer = page.locator("textarea");
  await composer.fill("$");
  await page
    .getByRole("listbox", { name: "Skills" })
    .getByRole("option", { name: /Review fixture/u })
    .click();
  await composer.fill("Review the fixture code.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Copy message" })).toHaveCount(2);
  expect(
    aiden.lmStudio.requests.some((request) =>
      JSON.stringify(request.body).includes("PRIVATE_SKILL_INSTRUCTION_MARKER"),
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("button", { name: "Skills", exact: true })
    .click();
  await page.getByRole("switch", { name: "Use skills globally" }).click();
  await expect(page.getByRole("switch", { name: "Use skills globally" })).not.toBeChecked();
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await composer.fill("Continue after disabling skills.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Copy message" })).toHaveCount(4);
  const next = [...aiden.lmStudio.requests].reverse().find((request) => {
    const body = request.body as { stream?: boolean };
    return (
      body?.stream === true && JSON.stringify(body).includes("Continue after disabling skills.")
    );
  });
  expect(next).toBeDefined();
  expect(JSON.stringify(next!.body)).not.toContain("PRIVATE_SKILL_INSTRUCTION_MARKER");
  await composer.fill("$");
  await expect(page.getByRole("listbox", { name: "Skills" }).getByRole("option")).toHaveCount(0);
});

test("workspace paths default hidden, change live, and survive relaunch", async ({ aiden }) => {
  let page = aiden.page;
  await finishLmStudioOnboarding(page);
  const workspaceName = "Aiden E2E workspace";
  const workspaceRow = () =>
    page.getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${workspaceName}`, "u") });
  await expect(workspaceRow()).toHaveText(workspaceName);

  const openAppearance = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Settings" })
      .getByRole("button", { name: "Appearance", exact: true })
      .click();
  };
  await openAppearance();
  const showPaths = () => page.getByRole("switch", { name: "Show workspace folder paths" });
  const format = () => page.getByRole("combobox", { name: "Workspace path format" });
  await expect(showPaths()).not.toBeChecked();
  await expect(format()).toBeDisabled();
  await showPaths().click();
  await format().click();
  await page.getByRole("option", { name: /Last folders/u }).click();
  // Wait for main-process persistence, not merely the optimistic preview.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { ipc } = (
          window as unknown as {
            aidenAPI: {
              ipc: {
                invoke(channel: string): Promise<{
                  appearance: { showWorkspacePaths: boolean; workspacePathFormat: string };
                }>;
              };
            };
          }
        ).aidenAPI;
        return (await ipc.invoke("settings:get")).appearance;
      }),
    )
    .toMatchObject({ showWorkspacePaths: true, workspacePathFormat: "end" });
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(workspaceRow()).toContainText("…/");

  page = await aiden.relaunch();
  await expect(workspaceRow()).toContainText("…/");
  await openAppearance();
  await expect(showPaths()).toBeChecked();
  await expect(format()).toContainText("Last folders");
  await showPaths().click();
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(workspaceRow()).toHaveText(workspaceName);
});

test("all Settings pages fit narrow and wide windows; Telegram toggles stay on the right", async ({
  aiden,
}) => {
  test.setTimeout(180_000);
  const { page, app } = aiden;
  await finishLmStudioOnboarding(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const navigation = page.getByRole("navigation", { name: "Settings" });
  const destinations = await navigation.getByRole("button").allTextContents();
  for (const destination of destinations) {
    // Navigate with the sidebar exposed, then test the compact content allocation.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
    if (await showSidebar.isVisible()) await showSidebar.click();
    await navigation.getByRole("button", { name: destination.trim(), exact: true }).click();
    for (const width of [1280, 600, 390]) {
      await app.evaluate(
        ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size, 650),
        width,
      );
      await expect
        .configure({ soft: true })
        .poll(
          () =>
            page.locator(".settings-responsive").evaluate((element) => {
              const page = element.querySelector(".settings-page")!;
              return Math.max(
                element.scrollWidth - element.clientWidth,
                page.scrollWidth - page.clientWidth,
              );
            }),
          { message: `${destination} at ${width}px` },
        )
        .toBeLessThanOrEqual(2);
      if (destination.trim() === "Telegram") {
        for (const name of [
          "Enable Telegram bridge",
          "Live answer drafts",
          "Private-chat threads",
        ]) {
          const toggle = page.getByRole("switch", { name, exact: true });
          await toggle.scrollIntoViewIfNeeded();
          expect(
            await toggle.evaluate((element) => {
              const row = element.closest('[role="group"]')!;
              const label = row.firstElementChild!;
              return element.getBoundingClientRect().left >= label.getBoundingClientRect().right;
            }),
          ).toBe(true);
        }
      }
    }
  }
});
