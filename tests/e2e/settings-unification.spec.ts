import { readFile } from "node:fs/promises";
import path from "node:path";
import { E2E_ASSISTANT_RESPONSE, expect, finishLmStudioOnboarding, test } from "./fixtures";

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
  // settings:get returns the sparse store; settings:getAppearance returns the
  // normalized config with defaults applied.
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
                showWorkspacePaths: boolean;
                workspacePathFormat: string;
              }>;
            };
          };
        }
      ).aidenAPI;
      return ipc.invoke("settings:getAppearance");
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
      const current = await ipc.invoke("settings:getAppearance");
      await ipc.invoke("settings:set", {
        appearance: { ...(current as object), ...value },
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
  // Live application runs through the real bootstrap path: on relaunch
  // useTheme hydrates the persisted config and applies it.
  page = await aiden.relaunch();
  await expect(workspaceRow()).toContainText("…/");

  await openAppearance();
  await expect(readAppearance()).resolves.toMatchObject({
    showWorkspacePaths: true,
    workspacePathFormat: "end",
  });
  await writeAppearance({ showWorkspacePaths: false, workspacePathFormat: "middle" });
  page = await aiden.relaunch();
  await expect(workspaceRow()).toHaveText(workspaceName);
});

test("theme tiles select a preset for both schemes, persist it, and reflow to the content width", async ({
  aiden,
}) => {
  let page = aiden.page;
  await finishLmStudioOnboarding(page);
  const openAppearance = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Settings" })
      .getByRole("button", { name: "Appearance", exact: true })
      .click();
  };
  // settings:getAppearance reports the live preview, which leads the
  // debounced durable write. Read the persisted file so a relaunch cannot
  // race the save.
  const readPresets = async () => {
    try {
      const appearance = JSON.parse(
        await readFile(path.join(aiden.userDataDir, "settings.json"), "utf8"),
      ).settings?.appearance;
      return { light: appearance?.light?.preset, dark: appearance?.dark?.preset };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const themes = () => page.getByRole("radiogroup", { name: "Themes", exact: true });
  const tile = (name: string) => themes().getByRole("radio", { name, exact: true });

  await openAppearance();
  await expect(themes().getByRole("radio")).toHaveCount(9);
  await expect(page.getByRole("radiogroup", { name: "Theme mode", exact: true }).getByRole("radio")).toHaveCount(3);

  await tile("Dusk").click();
  await expect(tile("Dusk")).toHaveAttribute("aria-checked", "true");
  await expect(themes().locator('[aria-checked="true"]')).toHaveCount(1);
  await expect(page.getByText("Current theme: Dusk", { exact: true })).toBeVisible();
  await expect.poll(readPresets).toEqual({ light: "dusk", dark: "dusk" });

  // Roving focus: arrow keys move focus and selection together.
  await tile("Dusk").press("ArrowRight");
  await expect(tile("Midnight")).toBeFocused();
  await expect(tile("Midnight")).toHaveAttribute("aria-checked", "true");
  await expect.poll(readPresets).toEqual({ light: "midnight", dark: "midnight" });

  page = await aiden.relaunch();
  await openAppearance();
  await expect(tile("Midnight")).toHaveAttribute("aria-checked", "true");

  const resizeWindow = (width: number) =>
    aiden.app.evaluate(
      ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size, 900),
      width,
    );
  const tileColumns = () =>
    themes().evaluate(
      (grid) =>
        new Set(
          [...grid.querySelectorAll('[role="radio"]')].map((radio) =>
            Math.round(radio.getBoundingClientRect().left),
          ),
        ).size,
    );
  const modeIcon = () =>
    page
      .getByRole("radiogroup", { name: "Theme mode", exact: true })
      .getByRole("radio", { name: "System", exact: true })
      .locator("svg");
  await resizeWindow(1280);
  await expect.poll(tileColumns).toBe(3);
  await expect(modeIcon()).toBeVisible();
  await resizeWindow(390);
  await expect.poll(tileColumns).toBe(2);
  await expect(modeIcon()).toBeHidden();
});

test("chat width setting resizes the transcript and composer together and persists", async ({
  aiden,
}) => {
  test.setTimeout(120_000);
  let page = aiden.page;
  await finishLmStudioOnboarding(page);
  await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1800, 900));
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1800);

  const prompt = "Chat width geometry probe";
  await page.locator("textarea").fill(prompt);
  await page.locator("textarea").press("Enter");
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE, { exact: true }).first()).toBeVisible();

  const widths = () =>
    page.evaluate((text) => {
      // The transcript column is the shared chat column holding the sent message.
      const transcript = [...document.querySelectorAll(".chat-content-column")].find(
        (element) =>
          !element.matches('[data-browser-composer-inset="true"]') && element.textContent?.includes(text),
      );
      const composer = document.querySelector('[data-browser-composer-inset="true"]');
      const viewport = transcript?.closest<HTMLElement>(".scroll-edge-mask");
      if (!transcript || !composer || !viewport) return null;
      const scrollContent = viewport.querySelector<HTMLElement>("[data-scroll-content]");
      if (!scrollContent) return null;
      const a = transcript.getBoundingClientRect();
      const b = composer.getBoundingClientRect();
      const scrollport = viewport.getBoundingClientRect();
      const content = scrollContent.getBoundingClientRect();
      const scrollportLeft = Math.round(scrollport.left + viewport.clientLeft);
      const scrollportRight = Math.round(scrollportLeft + viewport.clientWidth);
      return {
        transcript: Math.round(a.width),
        composer: Math.round(b.width),
        centerOffset: Math.abs(Math.round(a.left + a.width / 2 - (b.left + b.width / 2))),
        scrollbarGutter: viewport.offsetWidth - viewport.clientWidth,
        horizontalOverflow: Math.max(0, Math.round(content.right) - scrollportRight),
        transcriptRight: Math.round(a.right),
        scrollportLeft,
        scrollportRight,
        contentLeft: Math.round(content.left),
      };
    }, prompt);

  const scrollbarGutter = () => page.evaluate((text) => {
    const viewport = [...document.querySelectorAll<HTMLElement>(".scroll-edge-mask")].find(
      (element) => element.querySelector("[data-scroll-content]")?.textContent?.includes(text),
    );
    return viewport ? viewport.offsetWidth - viewport.clientWidth : null;
  }, prompt);
  const forceClassicGutter = async () => {
    await page.evaluate((text) => {
      const viewport = [...document.querySelectorAll<HTMLElement>(".scroll-edge-mask")].find(
        (element) => element.querySelector("[data-scroll-content]")?.textContent?.includes(text),
      );
      if (!viewport) throw new Error("Chat transcript scroll viewport was not found");
      // Measure the final native style, not the app's initial thin scrollbar.
      // Linux changes the reserved width when switching from thin to auto.
      Reflect.deleteProperty(viewport, "clientWidth");
      viewport.style.removeProperty("padding-inline-end");
      viewport.style.setProperty("overflow-y", "scroll", "important");
      viewport.style.setProperty("scrollbar-width", "auto", "important");
      const nativeGutter = Math.max(0, viewport.offsetWidth - viewport.clientWidth);
      const gutter = Math.max(16, nativeGutter);
      viewport.style.paddingInlineEnd = `${gutter - nativeGutter}px`;
      Object.defineProperty(viewport, "clientWidth", {
        configurable: true,
        get: () => viewport.offsetWidth - gutter,
      });
    }, prompt);
    await expect.poll(scrollbarGutter).toBeGreaterThan(0);
  };

  const chooseWidth = async (label: string) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Settings" })
      .getByRole("button", { name: "Appearance", exact: true })
      .click();
    const option = page
      .getByRole("radiogroup", { name: "Chat width", exact: true })
      .getByRole("radio", { name: label, exact: true });
    await option.click();
    await expect(option).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "Back to app", exact: true }).click();
    await expect.poll(widths).not.toBeNull();
  };

  const measured: Record<string, number> = {};
  for (const label of ["Narrow", "Default", "Wide", "Full"]) {
    await chooseWidth(label);
    // Chat-width changes may recreate the viewport; reapply the classic-gutter
    // fixture so every size, including Full, exercises scrollport compensation.
    await forceClassicGutter();
    await expect.poll(async () => {
      const current = await widths();
      return current && current.transcript === current.composer && current.centerOffset <= 1
        ? true
        : current;
    }, `${label} transcript and composer geometry`).toBe(true);
    const geometry = (await widths())!;
    measured[label] = geometry.transcript;
    if (label === "Full") {
      expect(geometry.scrollbarGutter).toBeGreaterThan(0);
      expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1);
      expect(geometry.contentLeft).toBeGreaterThanOrEqual(geometry.scrollportLeft - 1);
      expect(geometry.transcriptRight).toBeLessThanOrEqual(geometry.scrollportRight + 1);
    }
  }
  expect(measured.Narrow).toBeLessThan(measured.Default);
  expect(measured.Default).toBeLessThan(measured.Wide);
  expect(measured.Wide).toBeLessThan(measured.Full);

  // The preference is durable: a relaunch restores the same column width.
  await chooseWidth("Wide");
  await expect.poll(async () => {
    const appearance = JSON.parse(
      await readFile(path.join(aiden.userDataDir, "settings.json"), "utf8"),
    ).settings?.appearance;
    return appearance?.chatWidth;
  }).toBe("wide");
  page = await aiden.relaunch();
  await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1800, 900));
  await page.getByText("Chat width geometry probe").first().click();
  await expect.poll(async () => (await widths())?.transcript).toBe(measured.Wide);
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


test("model compaction budgets validate, survive relaunch and reset to defaults", async ({ aiden }) => {
  let page = aiden.page;
  await finishLmStudioOnboarding(page);
  const openMemory = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Memory", exact: true }).click();
  };
  await openMemory();
  await page.getByRole("combobox", { name: "Model for compaction budget" }).fill("fixture/exact-model");
  await page.getByRole("spinbutton", { name: "Compaction reserved tokens" }).fill("-1");
  await page.getByRole("button", { name: "Save budget", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("whole numbers");
  await page.getByRole("spinbutton", { name: "Compaction reserved tokens" }).fill("8192");
  await page.getByRole("spinbutton", { name: "Compaction recent tokens" }).fill("0");
  const modelKey = page.getByRole("combobox", { name: "Model for compaction budget" });
  await modelKey.fill("fixture/exact");
  await modelKey.pressSequentially("-model");
  await expect(page.getByRole("spinbutton", { name: "Compaction reserved tokens" })).toHaveValue("8192");
  await expect(page.getByRole("spinbutton", { name: "Compaction recent tokens" })).toHaveValue("0");
  await page.getByRole("button", { name: "Save budget", exact: true }).click();
  await expect(page.getByRole("button", { name: "fixture/exact-model", exact: true })).toBeVisible();
  await aiden.relaunch();
  page = aiden.page;
  await openMemory();
  await page.getByRole("button", { name: "fixture/exact-model", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "Compaction reserved tokens" })).toHaveValue("8192");
  await expect(page.getByRole("spinbutton", { name: "Compaction recent tokens" })).toHaveValue("0");
  await page.getByRole("button", { name: "Reset model", exact: true }).click();
  await expect(page.getByRole("button", { name: "fixture/exact-model", exact: true })).toHaveCount(0);
  await expect(page.getByRole("spinbutton", { name: "Compaction reserved tokens" })).toHaveValue("");
  await expect(page.getByRole("spinbutton", { name: "Compaction recent tokens" })).toHaveValue("");
  await page.reload();
  await openMemory();
  await expect(page.getByRole("button", { name: "fixture/exact-model", exact: true })).toHaveCount(0);
});


test("paid cache warming stays off until explicitly enabled and can be disabled after relaunch", async ({ aiden }) => {
  let page = aiden.page;
  const onboarding = page.locator('section[aria-label="Set up Aiden"]');
  await onboarding.getByPlaceholder("Your name").fill("E2E Local User");
  await onboarding.getByRole("button", { name: /^Next/u }).click();
  await expect(onboarding.getByText(/optional prompt cache warming/u)).toContainText("off by default");
  await onboarding.getByRole("button", { name: /LM Studio.*Use models running in LM Studio/u }).click();
  await onboarding.getByRole("button", { name: /^Next/u }).click();
  await onboarding.getByRole("button", { name: "Start using Aiden" }).click();
  await expect(onboarding).toBeHidden();
  const openMemory = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Memory", exact: true }).click();
  };
  await openMemory();
  const toggle = () => page.getByRole("switch", { name: "Warm prompt caches during active chats" });
  await expect(toggle()).not.toBeChecked();
  await expect(page.getByText(/Optional paid one-token requests/u)).toBeVisible();
  await toggle().click();
  await expect(toggle()).toBeChecked();
  await aiden.relaunch();
  page = aiden.page;
  await openMemory();
  await expect(toggle()).toBeChecked();
  await toggle().click();
  await expect(toggle()).not.toBeChecked();
  expect(aiden.lmStudio.requests.filter((request) => request.url === "/v1/chat/completions")).toHaveLength(0);
});
