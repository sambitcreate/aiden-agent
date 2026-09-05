import { expect, expectSquircleButtons, finishLmStudioOnboarding, test } from "./fixtures";

const PASTED_IMAGE_NAME = "Pasted image.png";
const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";

async function pasteImage(page: Parameters<typeof finishLmStudioOnboarding>[0]): Promise<void> {
  const composer = page.locator("textarea");
  await composer.evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], "clipboard.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    );
  }, ONE_PIXEL_PNG_BASE64);
  await expect(page.getByRole("button", { name: `Remove ${PASTED_IMAGE_NAME}` })).toBeVisible();
}

test("chat shell keeps local interactions isolated and keyboard-accessible", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);

  const composer = page.locator("textarea");
  const modelPicker = page.getByRole("button", { name: /^Selected model:/u });
  await modelPicker.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tablist", { name: "Model picker view" })).toBeVisible();
  await page.getByRole("tab", { name: "List" }).click();
  const modelFilter = page.getByRole("combobox", { name: "Chat model" });
  await expect(modelFilter).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(modelFilter).toBeHidden();
  await expect(modelPicker).toBeFocused();

  await composer.fill("/");
  const slashCommands = page.getByRole("listbox", { name: "Slash commands" });
  await expect(slashCommands).toBeVisible();
  await expect(slashCommands.getByRole("option", { name: /^Choose model/u })).toBeVisible();
  await composer.press("Escape");
  await expect(slashCommands).toBeHidden();
  await expect(composer).toHaveValue("/");

  await composer.fill("$");
  const skills = page.getByRole("listbox", { name: "Skills" });
  await expect(skills).toBeVisible();
  await expect(skills.getByText("No skills match this query.", { exact: true })).toBeVisible();
  await composer.press("Escape");
  await expect(skills).toBeHidden();
  await composer.fill("");

  const announcer = page.locator('[data-subagent-live-announcer="true"]');
  await expect(announcer).toHaveCount(1);
  const originalAnnouncer = await announcer.elementHandle();
  const assertAccessibleAnnouncer = async () => {
    await expect(announcer).toHaveCount(1);
    expect(await announcer.evaluate(el => el.closest('[inert], [aria-hidden="true"]') === null)).toBe(true);
    expect(await announcer.evaluate((el, original) => el === original, originalAnnouncer)).toBe(true);
  };
  await assertAccessibleAnnouncer();
  const environment = page.getByRole("button", { name: "Show Environment" });
  const quickViewToggle = page.locator("[data-quick-view-toggle]");
  const environmentSurface = page.getByRole("complementary", {
    name: "Environment work surface",
  });
  const quickView = page.getByRole("complementary", { name: "Quick View" });
  await expect(environment).toHaveAttribute("aria-pressed", "false");
  await expect(quickViewToggle).toHaveAttribute("aria-pressed", "false");
  await environment.click();
  await expect(environmentSurface).toBeVisible();
  await expect(environmentSurface.getByRole("tab", { name: "Review" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const reviewPanel = environmentSurface.getByRole("tabpanel", { name: "Review" });
  await expect(reviewPanel.getByText("No workspace folder", { exact: true })).toBeVisible();
  await expect(
    reviewPanel.getByText(
      "Choose a local workspace to review file changes beside the conversation.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide Environment" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await environmentSurface.getByRole("button", { name: "Show Quick View" }).click();
  await expect(quickView).toBeVisible();
  await expect(quickView.getByText("No workspace folder", { exact: true })).toBeVisible();
  await expect(
    quickView.getByText(
      "Choose a local workspace to see its environment, changes, and branch.",
      { exact: true },
    ),
  ).toBeVisible();
  await aiden.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(900, 720);
  });
  await expect(page.locator('[data-environment-stacked="true"]')).toHaveCount(1);
  await expect(page.locator('[data-environment-surface="tools"]')).toHaveAttribute('inert', '');
  await assertAccessibleAnnouncer();
  await expect(quickViewToggle).toHaveAttribute("aria-label", "Hide Quick View");
  await expect(quickViewToggle).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(quickView).toBeHidden();
  await expect(environmentSurface).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide Environment" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await environmentSurface.getByRole("button", { name: "Close environment panel" }).click();
  await expect(environmentSurface).toBeHidden();
  await expect(environment).toHaveAttribute("aria-pressed", "false");
  await assertAccessibleAnnouncer();
  await aiden.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1280, 800);
  });

  const terminal = page.getByRole("button", { name: "Show terminal" });
  await expect(terminal).toBeDisabled();
  await expect(terminal).toHaveAttribute("aria-pressed", "false");

  const permission = page.getByRole("button", {
    name: /^Workspace access: Ask first/u,
  });
  await permission.click();
  const accessOptions = page.getByRole("radiogroup", {
    name: "Workspace access",
  });
  const askFirst = accessOptions.getByRole("radio", {
    name: /^Workspace access: Ask first/u,
  });
  const noAccess = accessOptions.getByRole("radio", {
    name: /^Workspace access: No access/u,
  });
  await expect(askFirst).toHaveAttribute("aria-checked", "true");
  await expect(noAccess).toHaveAttribute("aria-checked", "false");
  await noAccess.click();
  const noAccessTrigger = page.getByRole("button", { name: /^Workspace access: No access/u });
  await expect(noAccessTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(composer).toBeFocused();
  await noAccessTrigger.click();
  await askFirst.click();
  await expect(permission).toBeVisible();

  await composer.fill("Draft and attachment stay with this chat only.");
  await pasteImage(page);
  const removeTarget = page.getByRole("button", { name: `Remove ${PASTED_IMAGE_NAME}` });
  const removeBox = await removeTarget.boundingBox();
  expect(removeBox?.width).toBeGreaterThanOrEqual(40);
  expect(removeBox?.height).toBeGreaterThanOrEqual(40);
  await removeTarget.click();
  await expect(page.getByRole("button", { name: `Remove ${PASTED_IMAGE_NAME}` })).toHaveCount(0);
  await pasteImage(page);

  await page.getByRole("button", { name: "New Agent", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("New agent");
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("button", { name: `Remove ${PASTED_IMAGE_NAME}` })).toHaveCount(0);

  const sidebarSearch = page.getByRole("searchbox", { name: "Search chats…" });
  await sidebarSearch.fill("not-a-real-chat-title");
  await expect(page.getByText("No matches", { exact: true })).toBeVisible();
  await sidebarSearch.fill("");
  await expect(page.getByText("No matches", { exact: true })).toBeHidden();

  await sidebarSearch.evaluate((element) => element.blur());
  const visibleSidebarToggle = page.getByRole("button", {
    name: "Hide sidebar",
  });
  await expect(visibleSidebarToggle).toHaveAttribute("aria-keyshortcuts", "Meta+B");
  await page.keyboard.press("Meta+B");
  const sidebarToggle = page.getByRole("button", { name: "Show sidebar" });
  await expect(sidebarToggle).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.locator("aside").filter({ has: page.locator("[data-sidebar]") }),
  ).toHaveAttribute("aria-hidden", "true");
  await page.keyboard.press("Meta+B");
  await expect(page.getByRole("button", { name: "Hide sidebar" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.keyboard.press("Meta+K");
  const palette = page.locator("[data-command-palette-content]");
  await expect(palette).toBeVisible();
  const commandSearch = page.getByRole("combobox", { name: "Search commands" });
  await commandSearch.fill("toggle sidebar");
  await expect(palette.getByText("Toggle sidebar", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
});

test.describe("with a workspace", () => {
  test.use({ workspaceSeed: true });

  test("joined editor actions keep square hover seams and visible keyboard focus", async ({ aiden }) => {
    const { app, page } = aiden;
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("workspaces:externalEditors");
      ipcMain.handle("workspaces:externalEditors", () => [{ id: "finder", label: "Finder", iconDataUrl: null }]);
    });
    await finishLmStudioOnboarding(page);
    const group = page.getByRole("group", { name: "Open workspace in editor" });
    const open = group.getByRole("button", { name: "Open workspace in Finder", exact: true });
    const choose = group.getByRole("button", { name: "Choose editor", exact: true });
    await expect(open).toBeEnabled();
    await expect(group).toHaveCSS("corner-shape", "squircle");
    await expect(group).toHaveCSS("border-radius", "16px");
    await expect(group).toHaveCSS("overflow", "visible");
    await expectSquircleButtons(page);
    for (const [button, seam] of [[open, "right"], [choose, "left"]] as const) {
      await button.hover();
      await expect(button).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(button).toHaveCSS(`border-top-${seam}-radius`, "0px");
      await expect(button).toHaveCSS(`border-bottom-${seam}-radius`, "0px");
    }
    await page.keyboard.press("Tab");
    await open.focus();
    await expect(open).toHaveCSS("outline-style", "solid");
    await open.press("Tab");
    await expect(choose).toBeFocused();
    await expect(choose).toHaveCSS("outline-style", "solid");
    await choose.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(choose).toBeFocused();
    await group.screenshot({ path: test.info().outputPath("joined-editor-actions.png") });
  });

  test("sidebar overflow menus stay to the right of the sidebar", async ({ aiden }) => {
    const { app, page } = aiden;
    await finishLmStudioOnboarding(page);

    const sidebar = page.locator("[data-sidebar]");
    const assertMenuClearsSidebar = async () => {
      const [sidebarBounds, menuBounds] = await Promise.all([
        sidebar.boundingBox(),
        page.getByRole("menu").boundingBox(),
      ]);
      expect(sidebarBounds).not.toBeNull();
      expect(menuBounds).not.toBeNull();
      expect(menuBounds!.x).toBeGreaterThanOrEqual(sidebarBounds!.x + sidebarBounds!.width);
    };

    await page.getByRole("button", { name: "Organize sidebar" }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await assertMenuClearsSidebar();
    await page.keyboard.press("Escape");

    await page.evaluate(async () => {
      const bridge = (
        window as unknown as {
          aidenAPI: {
            ipc: {
              invoke<T>(channel: string, ...args: unknown[]): Promise<T>;
            };
          };
        }
      ).aidenAPI.ipc;
      for (let index = 0; index < 12; index += 1) {
        await bridge.invoke("workspaces:create", {
          name: `Overflow fixture ${index + 1}`,
          permission: "ask",
        });
      }
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    const sidebarResizer = page.getByRole("separator", {
      name: "Resize sidebar",
    });
    await sidebarResizer.focus();
    await sidebarResizer.press("End");
    await expect(sidebarResizer).toHaveAttribute("aria-valuenow", "340");

    const workspaceActions = page.getByRole("button", {
      name: /^Actions for Aiden E2E workspace,/u,
    });
    await workspaceActions.evaluate((node) => node.scrollIntoView({ block: "end" }));
    const triggerBounds = await workspaceActions.boundingBox();
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    expect(triggerBounds).not.toBeNull();
    expect(triggerBounds!.y + triggerBounds!.height).toBeGreaterThan(viewportHeight / 2);
    await workspaceActions.focus();
    await workspaceActions.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await assertMenuClearsSidebar();
    await expect(page.getByRole("menu")).toHaveAttribute("data-align", "end");
    const menuBounds = await page.getByRole("menu").boundingBox();
    expect(menuBounds).not.toBeNull();
    expect(menuBounds!.y).toBeGreaterThanOrEqual(0);
    expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(viewportHeight);

    const originalWindowBounds = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getBounds(),
    );
    expect(originalWindowBounds).toBeDefined();
    await app.evaluate(
      ({ BrowserWindow }, bounds) => {
        BrowserWindow.getAllWindows()[0]?.setBounds(bounds);
      },
      {
        ...originalWindowBounds!,
        height: Math.max(520, originalWindowBounds!.height - 140),
      },
    );
    await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeLessThan(viewportHeight);
    await expect
      .poll(async () => {
        const [currentSidebarBounds, currentMenuBounds, currentViewportHeight] = await Promise.all([
          sidebar.boundingBox(),
          page.getByRole("menu").boundingBox(),
          page.evaluate(() => window.innerHeight),
        ]);
        return (
          currentSidebarBounds !== null &&
          currentMenuBounds !== null &&
          currentMenuBounds.x >= currentSidebarBounds.x + currentSidebarBounds.width &&
          currentMenuBounds.y >= 0 &&
          currentMenuBounds.y + currentMenuBounds.height <= currentViewportHeight
        );
      })
      .toBe(true);
    await assertMenuClearsSidebar();
    const resizedViewportHeight = await page.evaluate(() => window.innerHeight);
    const resizedMenuBounds = await page.getByRole("menu").boundingBox();
    expect(resizedMenuBounds).not.toBeNull();
    expect(resizedMenuBounds!.y).toBeGreaterThanOrEqual(0);
    expect(resizedMenuBounds!.y + resizedMenuBounds!.height).toBeLessThanOrEqual(
      resizedViewportHeight,
    );
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await app.evaluate(({ BrowserWindow }, bounds) => {
      BrowserWindow.getAllWindows()[0]?.setBounds(bounds);
    }, originalWindowBounds!);
  });

  test("workspace access arrows move focus and explicit keys commit", async ({ aiden }) => {
    const { page } = aiden;
    await finishLmStudioOnboarding(page);

    const permission = page.getByRole("button", {
      name: /^Workspace access: Full access/u,
    });
    await page.getByRole("button", { name: "Attach files or images" }).focus();
    await page.keyboard.press("Tab");
    await expect(permission).toBeFocused();
    await expect(permission).toHaveCSS("opacity", "1");
    await expect(permission).toHaveCSS("outline-style", "solid");
    await permission.click();
    const accessOptions = page.getByRole("radiogroup", {
      name: "Workspace access",
    });
    const fullAccess = accessOptions.getByRole("radio", {
      name: /^Workspace access: Full access/u,
    });
    const askFirst = accessOptions.getByRole("radio", {
      name: /^Workspace access: Ask first/u,
    });
    const noAccess = accessOptions.getByRole("radio", {
      name: /^Workspace access: No access/u,
    });
    await expect(permission).toHaveAttribute("aria-expanded", "true");
    await expect(permission).not.toHaveAttribute("aria-haspopup");
    await expect(accessOptions).toHaveAttribute("id", await permission.getAttribute("aria-controls") as string);
    // Clicking the already-selected Full option dismisses without a new grant.
    await fullAccess.click();
    await expect(permission).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".composer-shell textarea")).toBeFocused();
    await permission.click();
    await fullAccess.focus();
    await expect(fullAccess).toBeFocused();

    await fullAccess.press("ArrowDown");
    await expect(askFirst).toBeFocused();
    await expect(fullAccess).toHaveAttribute("aria-checked", "true");
    await askFirst.press("Enter");
    await expect(askFirst).toHaveAttribute("aria-checked", "true");

    await askFirst.press("ArrowUp");
    await expect(fullAccess).toBeFocused();
    await expect(page.getByRole("dialog", { name: "Enable Full Access?" })).toHaveCount(0);
    await expect(askFirst).toHaveAttribute("aria-checked", "true");

    await fullAccess.press("ArrowDown");
    await askFirst.press("ArrowDown");
    await expect(noAccess).toBeFocused();
    await expect(askFirst).toHaveAttribute("aria-checked", "true");
    await noAccess.press(" ");
    await expect(noAccess).toHaveAttribute("aria-checked", "true");

    await noAccess.press("ArrowUp");
    await expect(askFirst).toBeFocused();
    await expect(noAccess).toHaveAttribute("aria-checked", "true");
    await askFirst.press("Enter");
    await expect(askFirst).toHaveAttribute("aria-checked", "true");
    await askFirst.press("Escape");
    await expect(page.getByRole("button", { name: /^Workspace access: Ask first/u })).toHaveAttribute("aria-expanded", "false");
    await expect(accessOptions).toBeHidden();
    await expect(page.locator(".composer-shell textarea")).toBeFocused();
  });
});

test("compaction commands keep cancellation available for every engine", async ({ aiden }) => {
  const { app, page } = aiden;
  await finishLmStudioOnboarding(page);
  const composer = page.locator("textarea");
  await composer.fill("Create a chat for compaction command testing.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Copy message" })).toHaveCount(2);
  await expect(page.locator(".streaming-reveal")).toHaveCount(0);

  // Hold IPC open so even instant local compaction has a deterministic busy state.
  await app.evaluate(({ ipcMain }) => {
    let cancel: (() => void) | undefined;
    const state = { engines: [] as Array<string | null>, cancellations: 0, finishExport: () => {} };
    Object.assign(globalThis, { compactionCommandTest: state });
    ipcMain.removeHandler("chats:compact");
    ipcMain.removeHandler("chats:cancelCompact");
    ipcMain.removeHandler("chats:export");
    ipcMain.handle("chats:compact", (_event, _chatId, engine?: string) => {
      state.engines.push(engine ?? null);
      return new Promise((resolve) => {
        cancel = () => resolve({ compacted: false, reason: "cancelled" });
      });
    });
    ipcMain.handle("chats:cancelCompact", () => {
      state.cancellations++;
      cancel?.();
      return true;
    });
    ipcMain.handle(
      "chats:export",
      () =>
        new Promise((resolve) => {
          state.finishExport = () => resolve({ status: "cancelled" });
        }),
    );
  });

  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  for (const [command, status] of [
    ["compact", "Compacting chat…"],
    ["compact-LLM", "Compacting with LLM…"],
    ["compact-VCC", "Compacting with pi-vcc…"],
  ]) {
    await composer.fill(`/${command}`);
    await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
    await composer.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: status })).toBeVisible();
    await expect(cancel).toBeVisible();
    await expect(composer).toHaveAttribute("readonly", "");
    await cancel.click();
    await expect(cancel).toBeHidden();
    await expect(composer).toBeEditable();
  }
  expect(
    await app.evaluate(() => {
      const state = (
        globalThis as unknown as {
          compactionCommandTest: { engines: Array<string | null>; cancellations: number };
        }
      ).compactionCommandTest;
      return { engines: state.engines, cancellations: state.cancellations };
    }),
  ).toEqual({ engines: [null, "llm", "vcc"], cancellations: 3 });

  // Another session command must not inherit compaction's cancellation affordance.
  await composer.fill("/export");
  await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
  await composer.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Exporting chat…" })).toBeVisible();
  await expect(cancel).toBeHidden();
  await app.evaluate(() => {
    (
      globalThis as unknown as { compactionCommandTest: { finishExport: () => void } }
    ).compactionCommandTest.finishExport();
  });
  await expect(composer).toBeEditable();
});
