import { expect, finishLmStudioOnboarding, test } from "./fixtures";

test.use({ workspaceSeed: true });

test("Live audio selectors keep long labels and chevrons inside their bounds", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await page.evaluate(() => {
    localStorage.setItem("aiden.live.audio-devices.v1", JSON.stringify({ input: "fixture-mic", output: "fixture-speaker" }));
    Object.defineProperty(navigator.mediaDevices, "enumerateDevices", { configurable: true, value: async () => [
      { kind: "audioinput", deviceId: "fixture-mic", label: "MacBook Pro Microphone (Built-in) with a deliberately very long device name" },
      { kind: "audiooutput", deviceId: "fixture-speaker", label: "MacBook Pro Speakers (Built-in) with a deliberately very long device name" },
    ] });
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Aiden Live", exact: true }).click();
  for (const width of [1280, 600, 390]) {
    await aiden.app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size, 900), width);
    for (const name of ["Live input device", "Live output device"]) {
      const trigger = page.getByRole("combobox", { name });
      await expect(trigger).toContainText("MacBook Pro");
      await expect.poll(async () => trigger.evaluate((element) => {
        const outer = element.getBoundingClientRect();
        const label = element.firstElementChild!;
        const icon = element.lastElementChild!;
        const labelRect = label.getBoundingClientRect();
        const iconRect = icon.getBoundingClientRect();
        return getComputedStyle(element).flexWrap === "nowrap"
          && getComputedStyle(label).textOverflow === "ellipsis"
          && labelRect.right <= iconRect.left + 1
          && iconRect.right <= outer.right + 1
          && iconRect.bottom <= outer.bottom + 1;
      })).toBe(true);
    }
  }
});

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
  // The Appearance page no longer exposes workspace-path controls; the
  // underlying settings fields still round-trip through settings:set.
  const readAppearance = () =>
    page.evaluate(async () => {
      const { ipc } = (
        window as unknown as {
          aidenAPI: {
            ipc: {
              invoke(
                channel: string,
                patch?: unknown,
              ): Promise<{
                appearance: {
                  showWorkspacePaths: boolean;
                  workspacePathFormat: string;
                };
              }>;
            };
          };
        }
      ).aidenAPI;
      return (await ipc.invoke("settings:get")).appearance;
    });
  const writeAppearance = (patch: {
    showWorkspacePaths: boolean;
    workspacePathFormat: "middle" | "end" | "start";
  }) =>
    page.evaluate(async (value) => {
      const { ipc } = (
        window as unknown as {
          aidenAPI: {
            ipc: { invoke(channel: string, patch?: unknown): Promise<unknown> };
          };
        }
      ).aidenAPI;
      const current = (await ipc.invoke("settings:get")) as { appearance: unknown };
      await ipc.invoke("settings:set", {
        appearance: { ...(current.appearance as object), ...value },
      });
    }, patch);
  await expect(readAppearance()).resolves.toMatchObject({
    showWorkspacePaths: false,
    workspacePathFormat: "middle",
  });
  await writeAppearance({ showWorkspacePaths: true, workspacePathFormat: "end" });
  await expect(readAppearance()).resolves.toMatchObject({
    showWorkspacePaths: true,
    workspacePathFormat: "end",
  });
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(workspaceRow()).toContainText("…/");

  page = await aiden.relaunch();
  await expect(workspaceRow()).toContainText("…/");
  await openAppearance();
  await expect(readAppearance()).resolves.toMatchObject({
    showWorkspacePaths: true,
    workspacePathFormat: "end",
  });
  await writeAppearance({ showWorkspacePaths: false, workspacePathFormat: "middle" });
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
  const sidebar = page.locator("aside").filter({
    has: page.getByRole("navigation", { name: "Settings", includeHidden: true }),
  });
  const resizeWindow = async (width: number, height: number) => {
    await app.evaluate(
      ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height),
      { width, height },
    );
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
    if (width < 700) {
      // Wait for React's resize handler and the sidebar collapse before another
      // resize can make the one-shot Show sidebar check observe stale state.
      await expect(sidebar).toHaveAttribute("aria-hidden", "true");
      await expect.poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width))
        .toBe(0);
    }
  };
  const destinations = await navigation.getByRole("button").allTextContents();
  for (const destination of destinations) {
    // Navigate with the sidebar exposed, then test the compact content allocation.
    await resizeWindow(1280, 800);
    const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
    if (await showSidebar.isVisible()) await showSidebar.click();
    await navigation.getByRole("button", { name: destination.trim(), exact: true }).click();
    await expect(page.getByRole("heading", { name: destination.trim(), exact: true })).toHaveCount(
      1,
    );
    if (destination.trim() === "Telegram") {
      await page.getByText("Advanced Telegram settings", { exact: true }).click();
    }
    for (const width of [1280, 600, 390]) {
      await resizeWindow(width, 650);
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
