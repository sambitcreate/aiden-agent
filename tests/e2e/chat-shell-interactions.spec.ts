import { execFileSync } from "node:child_process";
import { getPresetVariant, resolveThemeTokens } from "../../renderer/shared/appearance";
import { expect, expectSquircleButtons, finishLmStudioOnboarding, test, type AidenE2e } from "./fixtures";

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
      name: "Actions for Aiden E2E workspace", exact: true,
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


test("composer selector menus use opaque theme surfaces on hover and keyboard focus", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  // The deterministic local model has no effort selector. Mount the real component's
  // markup to exercise its hover/focus CSS against the shipped renderer stylesheet.
  // Render outside Playwright, whose JSX transform serializes component objects.
  const thinkingMarkup = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { ThinkingControl } from "./renderer/components/thinking-control.tsx";
    process.stdout.write(renderToStaticMarkup(createElement(ThinkingControl, {
      level: "medium", levels: ["off", "low", "medium", "high"], onChange: () => undefined,
    })));
  `], { encoding: "utf8" });
  await page.evaluate((markup) => {
    const host = document.createElement("div");
    host.id = "thinking-surface-fixture";
    host.style.cssText = "position:fixed;right:40px;bottom:180px;z-index:100";
    host.innerHTML = markup;
    document.body.append(host);
  }, thinkingMarkup);
  const permission = page.getByRole("button", { name: /^Workspace access:/u });
  const access = page.getByRole("radiogroup", { name: "Workspace access", exact: true });
  const thinking = page.getByRole("radiogroup", { name: "Gemini thinking level" });
  const selectedThinking = thinking.getByRole("radio", { name: "Thinking: medium effort" });
  for (const scheme of ["light", "dark"] as const) {
    const tokens = resolveThemeTokens(getPresetVariant("aiden", scheme), scheme);
    const expected = await page.evaluate((themeTokens) => {
      for (const [name, value] of Object.entries(themeTokens)) document.documentElement.style.setProperty(name, value);
      const probe = document.createElement("div");
      probe.style.backgroundColor = "var(--surface-popover)";
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    }, tokens);
    expect(expected).toMatch(/^rgb\(/u);
    await permission.hover();
    await expect(access).toHaveCSS("background-color", expected);
    await expect(access).toHaveCSS("opacity", "1");
    await permission.press("Escape");
    await page.mouse.move(0, 0);
    await permission.focus();
    await expect(access).toHaveCSS("background-color", expected);
    await expect(access).toHaveCSS("opacity", "1");
    await permission.press("Escape");
    await selectedThinking.hover();
    await expect(thinking).toHaveCSS("background-color", expected);
    await selectedThinking.focus();
    await page.mouse.move(0, 0);
    await expect(thinking).toHaveCSS("background-color", expected);
    await expect(selectedThinking).toHaveCSS("outline-style", "solid");
    await page.locator("textarea").focus();
    await expect(thinking).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  }
});

async function seedPaletteChats({ app, page }: AidenE2e): Promise<void> {
  const workspaceId = await page.evaluate(() => localStorage.getItem("aiden-agent.workspaceId"));
  expect(workspaceId).toBeTruthy();
  await app.evaluate(({ ipcMain }, workspaceId) => {
    const chats = ["palette-chat-first", "palette-chat-second"].map((id) => ({
      id,
      workspaceId,
      title: "Repeated palette title",
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
      messages: [{ id: `message-${id}`, role: "user", content: `Opened ${id}`, createdAt: 1_800_000_000_000 }],
    }));
    ipcMain.removeHandler("chats:list");
    ipcMain.handle("chats:list", () => chats);
    ipcMain.removeHandler("chats:get");
    ipcMain.handle("chats:get", (_event, id) => ({
      chat: chats.find((chat) => chat.id === id) ?? null,
      imageArtifactRecoveryPending: false,
      imageArtifactRecoveryUnavailable: false,
      reconciliation: null,
    }));
  }, workspaceId);
  await page.reload();
  await expect(page.locator("textarea")).toBeVisible();
}

test("holding Command reveals chat shortcuts and typing outside a field lands in the composer", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await seedPaletteChats(aiden);

  const hints = page.locator('[data-chat-shortcut-hint="true"]');
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.down("Meta");
  await expect(hints).toHaveCount(2);
  await expect(hints.nth(0)).toHaveText("⌘1");
  await expect(hints.nth(1)).toHaveText("⌘2");
  await page.keyboard.up("Meta");
  await expect(hints).toHaveCount(0);

  // A quick chord must not flash the badges.
  await page.keyboard.press("Meta+1");
  await expect(page.getByText(/^Opened palette-chat-/u)).toBeVisible();
  await expect(hints).toHaveCount(0);

  const composer = page.locator("textarea");
  await expect(composer).toBeVisible();
  await composer.fill("");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.type("hi there");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("hi there");

  // Space activates a focused control instead of being redirected, and
  // ordinary typing inside another text field stays in that field.
  const modelPicker = page.getByRole("button", { name: /^Selected model:/u });
  await modelPicker.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("tablist", { name: "Model picker view" })).toBeVisible();
  await page.getByRole("tab", { name: "List" }).click();
  const modelFilter = page.getByRole("combobox", { name: "Chat model" });
  await expect(modelFilter).toBeFocused();
  await page.keyboard.type("zz");
  await expect(modelFilter).toHaveValue("zz");
  await expect(composer).toHaveValue("hi there");
  await page.keyboard.press("Escape");
  await expect(modelFilter).toBeHidden();

  // Disclosure summaries (activity feed, subagent detail) toggle on Space too.
  await page.evaluate(() => {
    const details = document.createElement("details");
    details.id = "type-focus-disclosure-fixture";
    details.innerHTML = "<summary>Disclosure</summary><p>Body</p>";
    details.style.cssText = "position:fixed;left:320px;top:80px;z-index:100";
    document.body.append(details);
  });
  const disclosure = page.locator("#type-focus-disclosure-fixture");
  await disclosure.locator("summary").focus();
  await page.keyboard.press("Space");
  await expect(disclosure).toHaveAttribute("open", "");
  await expect(composer).toHaveValue("hi there");
});

// Human-readable palette labels may legitimately collide. Keyboard selection
// must target the underlying chat/model identity, not the label string.
test("command palette selects each chat with identical labels independently", async ({ aiden }) => {
  const { app, page } = aiden;
  await finishLmStudioOnboarding(page);
  await seedPaletteChats(aiden);
  await page.keyboard.press("Meta+k");
  const palette = page.locator("[data-command-palette-content]");
  await palette.getByRole("combobox").fill("Search chats");
  await palette.getByRole("option", { name: "Search chats" }).click();
  const search = palette.getByRole("combobox", { name: "Search chats" });
  await search.fill("palette-chat");
  await expect(palette.getByRole("option")).toHaveCount(0);
  await search.fill("Repeated palette title");
  const rows = palette.getByRole("option");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
  await search.press("ArrowDown");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "false");
  await expect(search).toHaveAttribute("aria-activedescendant", await rows.nth(1).getAttribute("id") as string);

  // Background title/activity updates must refresh cmdk's search index while
  // the palette stays open, including when the current query stops matching.
  const updatedAt = Date.UTC(2035, 0, 1, 12);
  await app.evaluate(({ BrowserWindow }, updatedAt) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("chats:metadata-updated", {
        chatId: "palette-chat-second",
        title: "Zebra orchard renamed",
        updatedAt,
      });
    }
  }, updatedAt);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveText(/Repeated palette title/u);
  await search.fill("Zebra orchard renamed");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveText(/Zebra orchard renamed/u);
  await expect(rows.first()).toHaveAttribute("aria-selected", "true");
  await search.fill(await page.evaluate((time) => new Date(time).toLocaleString(), updatedAt));
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveText(/Zebra orchard renamed/u);
  await search.fill(await page.evaluate(() => new Date(1_800_000_000_000).toLocaleString()));
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveText(/Repeated palette title/u);
  await search.fill("palette-chat");
  await expect(rows).toHaveCount(0);
  await search.fill("Zebra orchard renamed");
  await expect(rows).toHaveCount(1);
  await search.fill("");
  await search.press("ArrowDown");
  const renamed = palette.getByRole("option", { name: /Zebra orchard renamed/u });
  await expect(renamed).toHaveAttribute("aria-selected", "true");
  await expect(search).toHaveAttribute("aria-activedescendant", await renamed.getAttribute("id") as string);
  await expect(search).toBeFocused();
  await search.press("Enter");
  await expect(palette).toBeHidden();
  await expect(page.getByText("Opened palette-chat-second", { exact: true })).toBeVisible();
  await expect(page.getByText("Opened palette-chat-first", { exact: true })).toHaveCount(0);
});

test("command palette selects same-named models from distinct provider identities", async ({ aiden }) => {
  const { app, page } = aiden;
  await finishLmStudioOnboarding(page);
  await app.evaluate(({ ipcMain }) => {
    const providers = ["zzq-provider-first", "zzq-provider-second"].map((id) => ({
      id,
      kind: "openai",
      label: "Repeated provider",
      baseUrl: "http://127.0.0.1:1234/v1",
      models: ["repeated-model"],
      needsKey: false,
      hasKey: false,
      deployment: "local",
    }));
    ipcMain.removeHandler("providers:list");
    ipcMain.handle("providers:list", () => providers);
  });
  await page.reload();
  await expect(page.locator("textarea")).toBeVisible();
  await page.keyboard.press("Meta+k");
  const palette = page.locator("[data-command-palette-content]");
  await palette.getByRole("option", { name: "Change model" }).click();
  const search = palette.getByRole("combobox", { name: "Search models" });
  await search.fill("Repeated provider");
  await expect(palette.getByRole("option")).toHaveCount(2);
  await search.fill("zzq-provider");
  await expect(palette.getByRole("option")).toHaveCount(0);
  await search.fill("repeated-model");
  const rows = palette.getByRole("option");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
  await search.press("ArrowDown");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "false");
  await search.press("ArrowUp");
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "true");
  await search.press("ArrowDown");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  const selectedId = await rows.nth(1).getAttribute("id");
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const providers = ["zzq-provider-first", "zzq-provider-second"].map((id) => ({
      id,
      kind: "openai",
      label: id === "zzq-provider-second" ? "Renamed provider" : "Repeated provider",
      baseUrl: "http://127.0.0.1:1234/v1",
      models: ["repeated-model"],
      needsKey: false,
      hasKey: false,
      deployment: "local",
    }));
    ipcMain.removeHandler("providers:list");
    ipcMain.handle("providers:list", () => providers);
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("app:config-externally-changed");
    }
  });
  const selected = palette.locator('[role="option"][aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  await expect(selected).toHaveAttribute("id", selectedId as string);
  await expect(selected).toContainText("Renamed provider");
  await expect(search).toHaveAttribute("aria-activedescendant", selectedId as string);
  await search.press("Enter");
  await expect(palette).toBeHidden();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("aiden-agent.providerId"))).toBe("zzq-provider-second");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("aiden-agent.model"))).toBe("repeated-model");
});

for (const field of ["title", "timestamp"] as const) {
  test(`command palette preserves selected chat on live ${field} change`, async ({ aiden }) => {
    const { app, page } = aiden;
    await finishLmStudioOnboarding(page);
    await seedPaletteChats(aiden);
    await page.keyboard.press("Meta+k");
    const palette = page.locator("[data-command-palette-content]");
    await palette.getByRole("option", { name: "Search chats" }).click();
    const search = palette.getByRole("combobox", { name: "Search chats" });
    await search.fill("Repeated palette title");
    const rows = palette.getByRole("option");
    await expect(rows).toHaveCount(2);
    await search.press("ArrowDown");
    await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
    const selectedId = await rows.nth(1).getAttribute("id");
    await app.evaluate(({ BrowserWindow }, field) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("chats:metadata-updated", {
          chatId: "palette-chat-second",
          title: field === "title" ? "Repeated palette title renamed" : "Repeated palette title",
          updatedAt: field === "timestamp" ? Date.UTC(2035, 0, 1, 12) : 1_800_000_000_000,
        });
      }
    }, field);
    const selected = palette.locator('[role="option"][aria-selected="true"]');
    await expect(selected).toHaveCount(1);
    await expect(selected).toHaveAttribute("id", selectedId as string);
    if (field === "title") await expect(selected).toContainText("renamed");
    else await expect(selected).toContainText("2035");
    await expect(search).toHaveAttribute("aria-activedescendant", selectedId as string);
    // No query edit or arrow recovery between the update and activation.
    await search.press("Enter");
    await expect(palette).toBeHidden();
    await expect(page.getByText("Opened palette-chat-second", { exact: true })).toBeVisible();
    await expect(page.getByText("Opened palette-chat-first", { exact: true })).toHaveCount(0);
  });
}

for (const mode of [
  { command: "chat.search", label: "chats" },
  { command: "model.change", label: "models" },
  { command: "provider.manage", label: "providers" },
  { command: "settings.search", label: "settings" },
]) {
  test(`command palette direct ${mode.label} entry discards stale root selection`, async ({ aiden }) => {
    const { app, page } = aiden;
    await finishLmStudioOnboarding(page);
    await page.keyboard.press("Meta+k");
    const palette = page.locator("[data-command-palette-content]");
    await palette.getByRole("combobox").fill("Toggle sidebar");
    await expect(palette.getByRole("option", { name: /Toggle sidebar/u })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    await app.evaluate(({ BrowserWindow, ipcMain }, command) => {
      // Avoid any provider-network work: Enter only verifies the palette action.
      ipcMain.removeHandler("providers:refresh");
      ipcMain.handle("providers:refresh", () => ({ providers: [], errors: [] }));
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("app:command", { commandId: command });
      }
    }, mode.command);
    const search = palette.getByRole("combobox", { name: `Search ${mode.label}` });
    await expect(search).toBeVisible();
    await expect(search).toHaveValue("");
    const selected = palette.locator('[role="option"][aria-selected="true"]');
    await expect(selected).toHaveCount(1);
    await expect(selected).toHaveAttribute("aria-disabled", "false");
    await search.press("Enter");
    if (mode.label === "providers") {
      await expect(page.getByText("Provider model catalogs refreshed", { exact: true })).toBeVisible();
    } else {
      await expect(palette).toBeHidden();
    }
  });
}

test("command palette clears hidden and disabled selection and reselects across back navigation", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await page.keyboard.press("Meta+k");
  const palette = page.locator("[data-command-palette-content]");
  const search = palette.getByRole("combobox");
  await search.fill("Toggle sidebar");
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
  await search.fill("zzq-no-such-command");
  await expect(palette.getByRole("option")).toHaveCount(0);
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toHaveCount(0);
  await search.press("Enter");
  await expect(palette).toBeVisible();
  await search.fill("Open workspace in preferred editor");
  await expect(palette.getByRole("option").first()).toHaveAttribute("aria-disabled", "true");
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toHaveCount(0);
  await search.press("Enter");
  await expect(palette).toBeVisible();
  await search.fill("Search chats");
  await search.press("Enter");
  await expect(search).toHaveAttribute("aria-label", "Search chats");
  await expect(palette.getByRole("option", { name: /^New chat/u })).toHaveAttribute("aria-selected", "true");
  await search.press("Escape");
  await expect(search).toHaveAttribute("aria-label", "Search commands");
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
  // Search chats is now the recent root command. Enter re-enters that mode,
  // and the next Enter activates its New chat default without arrow recovery.
  await expect(palette.getByRole("option", { name: "Search chats" })).toHaveAttribute("aria-selected", "true");
  await search.press("Enter");
  await expect(search).toHaveAttribute("aria-label", "Search chats");
  await search.press("Enter");
  await expect(palette).toBeHidden();
});

test("command palette loads model results when settings resolve after providers", async ({ aiden }) => {
  const { app, page } = aiden;
  await finishLmStudioOnboarding(page);
  const settings = await page.evaluate(async () => {
    const { ipc } = (window as unknown as {
      aidenAPI: { ipc: { invoke(channel: string): Promise<Record<string, unknown>> } };
    }).aidenAPI;
    const settings = await ipc.invoke("settings:get");
    delete settings.hiddenModelsByProvider;
    return settings;
  });
  await app.evaluate(({ ipcMain }, settings) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    Object.assign(globalThis, { paletteReleaseSettings: release });
    ipcMain.removeHandler("settings:get");
    ipcMain.handle("settings:get", async () => { await gate; return settings; });
    ipcMain.removeHandler("providers:list");
    ipcMain.handle("providers:list", () => ["first", "second"].map((id) => ({
      id: `late-settings-${id}`,
      kind: "openai",
      label: "Delayed settings provider",
      baseUrl: "http://127.0.0.1:1234/v1",
      models: ["readiness-model"],
      needsKey: false,
      hasKey: false,
      deployment: "local",
    })));
  }, settings);
  await page.reload();
  await expect(page.locator("textarea")).toBeVisible();
  await page.keyboard.press("Meta+k");
  const palette = page.locator("[data-command-palette-content]");
  await palette.getByRole("option", { name: "Change model" }).click();
  const search = palette.getByRole("combobox", { name: "Search models" });
  await expect(search).toBeVisible();
  await expect(palette.getByText("Loading models…", { exact: true })).toBeHidden();
  await expect(palette.getByRole("option")).toHaveCount(0);
  await app.evaluate(() => {
    (globalThis as unknown as { paletteReleaseSettings: () => void }).paletteReleaseSettings();
  });
  await expect(palette.getByRole("option")).toHaveCount(2);
  await search.fill("Delayed settings provider");
  await expect(palette.getByRole("option")).toHaveCount(2);
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
  await search.press("Enter");
  await expect(palette).toBeHidden();
});

test("command palette prefers matching provider actions over forced retries", async ({ aiden }) => {
  const { app, page } = aiden;
  await finishLmStudioOnboarding(page);
  await app.evaluate(({ ipcMain }) => {
    const state = { listCalls: 0, refreshCalls: 0, releaseRefresh: () => {} };
    const refreshGate = new Promise<void>((resolve) => { state.releaseRefresh = resolve; });
    Object.assign(globalThis, { paletteProviderError: state });
    ipcMain.removeHandler("providers:list");
    ipcMain.handle("providers:list", () => {
      state.listCalls++;
      throw new Error("Intentional palette provider failure");
    });
    ipcMain.removeHandler("providers:refresh");
    ipcMain.handle("providers:refresh", async () => {
      state.refreshCalls++;
      await refreshGate;
      throw new Error("Intentional catalog refresh failure");
    });
  });
  await page.reload();
  await expect(page.locator("textarea")).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("app:command", { commandId: "provider.manage" });
    }
  });
  const palette = page.locator("[data-command-palette-content]");
  const search = palette.getByRole("combobox", { name: "Search providers" });
  const retry = palette.getByRole("option", { name: /Providers could not be loaded/u });
  const refresh = palette.getByRole("option", { name: /Refresh.*providers|Refresh provider catalogs/u });
  await expect(retry).toBeVisible();
  await search.fill("Retry");
  await expect(retry).toHaveAttribute("aria-selected", "true");
  await search.fill("Refresh");
  // Activate immediately after editing, without waiting for selection or arrows.
  await search.press("Enter");
  await expect.poll(() => app.evaluate(() =>
    (globalThis as unknown as { paletteProviderError: { refreshCalls: number } }).paletteProviderError.refreshCalls,
  )).toBe(1);
  // Refresh is disabled while busy, so the visible retry becomes the fallback.
  await expect(refresh).toHaveAttribute("aria-disabled", "true");
  await expect(retry).toHaveAttribute("aria-selected", "true");
  await search.fill("🧪 no matching palette result");
  await expect(retry).toHaveAttribute("aria-selected", "true");
  const callsBeforeRetry = await app.evaluate(() =>
    (globalThis as unknown as { paletteProviderError: { listCalls: number } }).paletteProviderError.listCalls,
  );
  await search.press("Enter");
  await expect.poll(() => app.evaluate(() =>
    (globalThis as unknown as { paletteProviderError: { listCalls: number } }).paletteProviderError.listCalls,
  )).toBeGreaterThan(callsBeforeRetry);
  await search.fill("");
  await expect(retry).toHaveAttribute("aria-selected", "true");
  await search.fill("Refresh");
  await expect(retry).toHaveAttribute("aria-selected", "true");
  await app.evaluate(() => {
    (globalThis as unknown as { paletteProviderError: { releaseRefresh: () => void } }).paletteProviderError.releaseRefresh();
  });
  await expect(refresh).toHaveAttribute("aria-disabled", "false");
  // The query is unchanged when Refresh becomes enabled. cmdk does not perform
  // its query-change auto-selection here; reconciliation must leave the fallback.
  await expect(refresh).toHaveAttribute("aria-selected", "true");
  await expect(retry).toHaveAttribute("aria-selected", "false");
  await search.press("Enter");
  await expect.poll(() => app.evaluate(() =>
    (globalThis as unknown as { paletteProviderError: { refreshCalls: number } }).paletteProviderError.refreshCalls,
  )).toBe(2);
});

for (const mode of [
  { command: "chat.search", label: "chats", channel: "chats:list", ordinary: "New chat" },
  { command: "model.change", label: "models", channel: "providers:list", ordinary: "Aiden E2E Vision" },
]) {
  test(`command palette ${mode.label} retry fallback follows errors and recovery`, async ({ aiden }) => {
    const { app, page } = aiden;
    await finishLmStudioOnboarding(page);
    const providers = await page.evaluate(() =>
      (window as unknown as { aidenAPI: { ipc: { invoke(channel: string): Promise<unknown> } } })
        .aidenAPI.ipc.invoke("providers:list"),
    );
    await app.evaluate(({ ipcMain }, { channel, providers }) => {
      const state = { recovered: false, calls: 0, release: () => {} };
      const gate = new Promise<void>((resolve) => { state.release = resolve; });
      // Initial provider loading gates the entire shell; let it reach error so
      // model mode can open. Chats loading leaves the palette shell available.
      if (channel === "providers:list") state.release();
      Object.assign(globalThis, { paletteRecovery: state });
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async () => {
        state.calls++;
        await gate;
        if (!state.recovered) throw new Error("Intentional palette loading failure");
        return channel === "chats:list" ? [] : providers;
      });
    }, { channel: mode.channel, providers });
    await page.reload();
    // The composer waits on these reads; the shell and palette are available
    // while they are pending, which is the loading state under test.
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible({ timeout: 15_000 });
    await app.evaluate(({ BrowserWindow }, command) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("app:command", { commandId: command });
      }
    }, mode.command);
    const palette = page.locator("[data-command-palette-content]");
    const search = palette.getByRole("combobox", { name: `Search ${mode.label}` });
    await search.fill("🧪 no matching palette result");
    const selected = palette.locator('[role="option"][aria-selected="true"]');
    if (mode.label === "chats") {
      await expect(palette.getByRole("option", { name: "Loading chats…" })).toHaveAttribute("aria-disabled", "true");
      await expect(selected).toHaveCount(0);
      await search.press("Enter");
      await expect(palette).toBeVisible();
      await app.evaluate(() => {
        (globalThis as unknown as { paletteRecovery: { release: () => void } }).paletteRecovery.release();
      });
    }
    const retry = palette.getByRole("option", { name: /could not be loaded/u });
    await expect(retry).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
    await search.fill(mode.ordinary);
    if (mode.label === "chats") {
      await expect(palette.getByRole("option", { name: /^New chat/u })).toHaveAttribute("aria-selected", "true");
      await expect(retry).toHaveAttribute("aria-selected", "false");
    } else {
      // Model errors replace ordinary results; retry is the only enabled row.
      await expect(retry).toHaveAttribute("aria-selected", "true");
    }
    await search.fill("🧪 no matching palette result");
    await expect(retry).toHaveAttribute("aria-selected", "true");
    await app.evaluate(() => {
      (globalThis as unknown as { paletteRecovery: { recovered: boolean } }).paletteRecovery.recovered = true;
    });
    await search.press("Enter");
    await expect(retry).toHaveCount(0);
    await expect(palette.getByRole("option")).toHaveCount(0);
    await expect(selected).toHaveCount(0);
    await search.fill(mode.ordinary);
    await expect(selected).toHaveCount(1);
    await search.press("Enter");
    await expect(palette).toBeHidden();
  });
}
