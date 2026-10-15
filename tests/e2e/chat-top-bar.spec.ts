import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, finishLmStudioOnboarding, test, waitForToastsToClear } from "./fixtures";

function contextBar(page: Page) {
  return page.locator('[role="group"][aria-label="Composer workspace bar"]');
}

function pullRequestChip(page: Page) {
  return contextBar(page).getByRole("button", { name: /^Pull requests for this chat/u });
}

async function startPersistedChat(page: Page, beforeSend?: () => Promise<void>): Promise<void> {
  await finishLmStudioOnboarding(page);
  await beforeSend?.();
  await page.locator("textarea").fill("Top bar check");
  await page.locator("textarea").press("Enter");
  await expect(page.locator("[data-chat-title-menu]")).toBeVisible({ timeout: 20_000 });
  await waitForToastsToClear(page);
}

async function openChipMenu(page: Page) {
  await page.locator("[data-workspace-chip]").click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
}

test.describe("folder workspaces", () => {
  test.use({ workspaceSeed: true });

  test("a plain folder gets folder actions but no Git-only ones", async ({ aiden }) => {
    const { page } = aiden;
    await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    await startPersistedChat(page, async () => {
      // A plain-folder draft offers the workspace, with no "Local" label or PR chip.
      await expect(contextBar(page)).toHaveAttribute("data-mode", "full");
      await expect(contextBar(page).getByRole("button", { name: "Choose a workspace" })).toBeVisible();
      await expect(contextBar(page).getByText("Local", { exact: true })).toHaveCount(0);
      await expect(pullRequestChip(page)).toHaveCount(0);
    });
    // After the first message the header names the workspace; the bar hides.
    await expect(contextBar(page)).toHaveAttribute("data-mode", "hidden");

    await expect(page.locator("[data-workspace-chip]")).toHaveAccessibleName(
      "Workspace Aiden E2E workspace",
    );
    const menu = await openChipMenu(page);
    await expect(menu.getByText("Not a Git repository", { exact: true })).toBeVisible();
    await expect(menu.getByText(aiden.workspaceDir, { exact: true })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Copy folder path" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Copy branch name" })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Open on GitHub" })).toHaveCount(0);
    await closeMenu(page);

    // Changes needs a repository; Files and Browser do not.
    await expect(page.locator('[data-workspace-tool="review"]')).toHaveCount(0);
    const files = page.locator('[data-workspace-tool="files"]');
    await expect(files).toHaveAccessibleName("Show Files");
    await files.click();
    const panel = page.getByRole("complementary", { name: "Environment work surface" });
    await expect(panel.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(files).toHaveAttribute("aria-pressed", "true");
    await expect(files).toHaveAccessibleName("Hide Files");
    await files.click();
    await expect(panel).toBeHidden();
    await expect(files).toHaveAttribute("aria-pressed", "false");

    // Pressing a different tool while one is showing switches the panel to it.
    const browser = page.locator('[data-workspace-tool="browser"]');
    await files.click();
    await browser.click();
    await expect(browser).toHaveAttribute("aria-pressed", "true");
    await expect(files).toHaveAttribute("aria-pressed", "false");
    await expect(panel).toBeVisible();
  });

  test("a Git repository adds branch, GitHub, and Changes", async ({ aiden }) => {
    const { page } = aiden;
    execFileSync("git", ["init", "-b", "main", aiden.workspaceDir]);
    execFileSync("git", [
      "-C", aiden.workspaceDir,
      "-c", "user.email=e2e@example.com",
      "-c", "user.name=Aiden E2E",
      "commit", "--allow-empty", "-m", "init",
    ]);
    execFileSync("git", [
      "-C", aiden.workspaceDir,
      "remote", "add", "origin", "https://github.com/example-owner/example-repo.git",
    ]);
    await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    await startPersistedChat(page, async () => {
      await expect(pullRequestChip(page)).toHaveCount(0);
    });
    // The bar collapses to the branch; nothing is ready to open as a PR yet.
    await expect(contextBar(page)).toHaveAttribute("data-mode", "summary");
    await expect(contextBar(page).getByRole("button", { name: "main", exact: true })).toBeVisible();
    await expect(contextBar(page).getByRole("button", { name: "Choose a workspace" })).toHaveCount(0);
    await expect(pullRequestChip(page)).toHaveCount(0);

    const menu = await openChipMenu(page);
    await expect(menu.locator("[data-workspace-chip-status]")).toHaveText("main");
    await expect(menu.getByRole("menuitem", { name: "Copy branch name" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Open on GitHub" })).toBeVisible();
    await closeMenu(page);

    const changes = page.locator('[data-workspace-tool="review"]');
    await changes.click();
    const panel = page.getByRole("complementary", { name: "Environment work surface" });
    await expect(panel.locator("#environment-review-tab")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(changes).toHaveAttribute("aria-pressed", "true");
  });

  test("a draft in New worktree mode creates its worktree on send and runs there", async ({ aiden }) => {
    const { page } = aiden;
    execFileSync("git", ["init", "-b", "main", aiden.workspaceDir]);
    execFileSync("git", [
      "-C", aiden.workspaceDir,
      "-c", "user.email=e2e@example.com",
      "-c", "user.name=Aiden E2E",
      "commit", "--allow-empty", "-m", "init",
    ]);
    await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    await finishLmStudioOnboarding(page);

    // Nothing is created yet: the chip and the headline describe the plan.
    await contextBar(page).getByRole("button", { name: "main", exact: true }).click();
    const workIn = page.getByRole("radiogroup", { name: "Work in" });
    await expect(workIn.getByRole("radio", { name: /^This checkout/u })).toHaveAttribute("aria-checked", "true");
    await workIn.getByRole("radio", { name: /^New worktree/u }).click();
    await expect(page.getByRole("radiogroup", { name: "Start from" }).getByRole("radio", { name: /^main/u }))
      .toHaveAttribute("aria-checked", "true");
    // No remote, so there is no origin to start from.
    await expect(page.getByRole("menu").getByRole("switch")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(
      contextBar(page).getByRole("button", { name: "Branch: new worktree from main" }),
    ).toHaveText("New worktree · from main");
    await expect(page.locator("[data-draft-worktree-hint]")).toHaveText(
      "A new worktree from main will be created when you send",
    );
    expect(execFileSync("git", ["-C", aiden.workspaceDir, "worktree", "list"], { encoding: "utf8" }).trim().split("\n"))
      .toHaveLength(1);

    // Record the progress row, which may only be on screen briefly.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { __worktreeProgress: string[] }).__worktreeProgress = seen;
      new MutationObserver(() => {
        for (const row of document.querySelectorAll("[data-worktree-send-progress]")) {
          const text = row.textContent ?? "";
          if (text && seen[seen.length - 1] !== text) seen.push(text);
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.locator("textarea").fill("Fix the login bug");
    await page.locator("textarea").press("Enter");
    await expect(page.locator("[data-chat-title-menu]")).toBeVisible({ timeout: 20_000 });

    // The message showed straight away with the worktree's progress.
    const progress = await page.evaluate(
      () => (window as unknown as { __worktreeProgress: string[] }).__worktreeProgress,
    );
    expect(progress.some((text) => /^Creating worktree/u.test(text))).toBe(true);

    // The chat now runs in the new worktree: the summary chip names its branch.
    await expect(contextBar(page)).toHaveAttribute("data-mode", "summary");
    await expect(
      contextBar(page).getByRole("button", { name: /^aiden\/fix-the-login-bug, worktree/u }),
    ).toBeVisible();
    const worktrees = execFileSync("git", ["-C", aiden.workspaceDir, "worktree", "list"], { encoding: "utf8" });
    expect(worktrees).toContain("[aiden/fix-the-login-bug]");

    // The worktree is registered as a workspace, listed in the sidebar.
    const worktreeWorkspace = await page.evaluate(async () => {
      const bridge = (window as unknown as {
        aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } };
      }).aidenAPI.ipc;
      const workspaces = await bridge.invoke<{ id: string; name: string; managedWorktree?: { branch: string } }[]>(
        "workspaces:list",
      );
      return workspaces.find((workspace) => workspace.managedWorktree?.branch === "aiden/fix-the-login-bug");
    });
    expect(worktreeWorkspace).toBeDefined();
    await expect(
      page.getByRole("button", { name: `New chat in ${worktreeWorkspace!.name}`, exact: true }),
    ).toHaveCount(1);

    // The chat was saved in the worktree and its first response ran there.
    await expect
      .poll(async () => {
        const index = JSON.parse(
          await readFile(path.join(aiden.userDataDir, "chats", "index.json"), "utf8"),
        ) as { id: string; workspaceId?: string; botId?: string }[];
        const meta = index.find((entry) => !entry.botId && entry.workspaceId === worktreeWorkspace!.id);
        if (!meta) return "no chat in the worktree";
        const saved = JSON.parse(
          await readFile(path.join(aiden.userDataDir, "chats", `${meta.id}.json`), "utf8"),
        ) as { messages: { role: string; providerFailure?: unknown }[] };
        const reply = saved.messages.find((message) => message.role === "assistant");
        return reply ? (reply.providerFailure ? "failed" : "answered") : "waiting";
      }, { timeout: 20_000 })
      .toBe("answered");
    await expect(page.getByText("Generation failed")).toHaveCount(0);
  });

  test("⌥↵ in New chat in… opens the draft with New worktree selected", async ({ aiden }) => {
    const { page } = aiden;
    execFileSync("git", ["init", "-b", "main", aiden.workspaceDir]);
    execFileSync("git", [
      "-C", aiden.workspaceDir,
      "-c", "user.email=e2e@example.com",
      "-c", "user.name=Aiden E2E",
      "commit", "--allow-empty", "-m", "init",
    ]);
    await finishLmStudioOnboarding(page);
    await expect(contextBar(page).getByRole("button", { name: "main", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "New Agent", exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+Shift+N");
    await expect(page.getByRole("combobox", { name: "Search workspaces" })).toBeFocused();
    await expect(page.locator("[data-new-chat-in-footer]")).toHaveText("⌥↵ in a new worktree");
    await page.keyboard.press("Alt+Enter");
    await expect(page.locator("[data-command-palette-content]")).toHaveCount(0);
    await expect(
      contextBar(page).getByRole("button", { name: "Branch: new worktree from main" }),
    ).toBeVisible();
    await expect(page.locator("textarea")).toBeFocused();
  });

  test("the headline name opens the workspace menu, and a typed path moves the draft there", async ({ aiden }) => {
    const { page } = aiden;
    // HOME is the test root, so ~/typed-project resolves inside it.
    const typedFolder = path.join(aiden.rootDir, "typed-project");
    await mkdir(typedFolder);
    await finishLmStudioOnboarding(page);
    const composer = page.locator("textarea");
    await composer.fill("Keep this draft text");
    const headline = page.locator("[data-new-chat-headline]");
    await expect(headline).toHaveText("What should we build in Aiden E2E workspace?");

    await headline.getByRole("button", { name: "Aiden E2E workspace" }).click();
    const search = page.getByRole("combobox", { name: "Search workspaces" });
    await expect(search).toBeFocused();
    await expect(page.getByRole("option", { name: /^Scratch chat/u })).toBeVisible();
    await search.fill("~/typed-project");
    const open = page.getByRole("option", { name: /^Open \/.*typed-project/u });
    await expect(open).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");

    // The draft keeps its text and focus, now in the typed folder.
    await expect(search).toHaveCount(0);
    await expect(headline).toHaveText("What should we build in typed-project?");
    await expect(composer).toHaveValue("Keep this draft text");
    await expect(composer).toBeFocused();
    await composer.press("Enter");
    await expect(page.locator("[data-chat-title-menu]")).toBeVisible({ timeout: 20_000 });
    const chats = JSON.parse(await readFile(path.join(aiden.userDataDir, "chats", "index.json"), "utf8")) as {
      workspaceId?: string;
      botId?: string;
    }[];
    const [chat] = chats.filter((entry) => !entry.botId && entry.workspaceId && entry.workspaceId !== "assistant");
    const workspace = await page.evaluate(async (workspaceId) => {
      const bridge = (window as unknown as {
        aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } };
      }).aidenAPI.ipc;
      return bridge.invoke<{ folderPath?: string } | null>("workspaces:get", workspaceId);
    }, chat.workspaceId);
    expect(workspace?.folderPath?.endsWith(`${path.sep}typed-project`)).toBe(true);
  });

  test("the title menu renames the chat everywhere it is shown", async ({ aiden }) => {
    const { page } = aiden;
    await startPersistedChat(page);
    await page.locator("[data-chat-title-menu]").click();
    await page.getByRole("menuitem", { name: "Rename…" }).click();
    const dialog = page.getByRole("dialog", { name: "Rename chat" });
    await dialog.getByRole("textbox", { name: "Chat name" }).fill("Renamed from the top bar");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("[data-chat-title-menu]")).toContainText("Renamed from the top bar");
    await expect(
      page.locator("[data-sidebar]").getByText("Renamed from the top bar", { exact: true }),
    ).toBeVisible();
  });
  test("turning workspace access off hides repository and folder actions", async ({ aiden }) => {
    const { page } = aiden;
    execFileSync("git", ["init", "-b", "main", aiden.workspaceDir]);
    await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    await startPersistedChat(page);
    await expect(page.locator('[data-workspace-tool="review"]')).toBeVisible();

    await page.getByRole("button", { name: /^Workspace access: Full access/u }).click();
    await page
      .getByRole("radiogroup", { name: "Workspace access" })
      .getByRole("radio", { name: /^Workspace access: No access/u })
      .click();
    await expect(page.getByRole("button", { name: /^Workspace access: No access/u })).toBeVisible();

    await expect(page.locator('[data-workspace-tool="review"]')).toHaveCount(0);
    await expect(page.locator('[data-workspace-tool="files"]')).toBeDisabled();
    const menu = await openChipMenu(page);
    await expect(menu.locator("[data-workspace-chip-status]")).toHaveText("Workspace access is off");
    await expect(menu.getByRole("menuitem", { name: /Show in Finder|Open folder/u })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Copy branch name" })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Copy folder path" })).toBeVisible();
    await closeMenu(page);
  });

  test("a narrow window keeps the title readable and nothing overlaps", async ({ aiden }) => {
    const { page } = aiden;
    await startPersistedChat(page);
    const title = page.locator("[data-chat-title-menu]");
    const chip = page.locator("[data-workspace-chip]");
    const tools = page.locator("[data-workspace-tool-buttons]");
    // 680px forces the sidebar closed; 760px leaves it to the saved state.
    for (const width of [680, 760, 900]) {
      await aiden.app.evaluate(
        ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size, 800),
        width,
      );
      await expect.poll(async () => {
        const [titleBox, chipBox, toolsBox] = await Promise.all([
          title.boundingBox(),
          chip.isVisible().then((visible) => (visible ? chip.boundingBox() : null)),
          tools.boundingBox(),
        ]);
        if (!titleBox || !toolsBox) return `missing at ${width}`;
        if (titleBox.width < 80) return `title ${titleBox.width}px at ${width}`;
        const titleEnd = titleBox.x + titleBox.width;
        if (chipBox && (chipBox.x < titleEnd || chipBox.x + chipBox.width > toolsBox.x)) {
          return `chip overlaps at ${width}`;
        }
        if (!chipBox && titleEnd > toolsBox.x) return `title overlaps at ${width}`;
        return "ok";
      }).toBe("ok");
    }
  });
  test("Quick View leads the workspace tools and Environment ends them", async ({ aiden }) => {
    const { page } = aiden;
    await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    await startPersistedChat(page);
    const group = page.locator("[data-workspace-tool-buttons]");
    const toggles = {
      quickView: group.locator("[data-quick-view-toggle]"),
      terminal: group.locator("[data-terminal-toggle]"),
      more: group.locator('button[aria-label="More workspace tools"]'),
      environment: group.locator("[data-environment-toggle]"),
    };
    for (const toggle of Object.values(toggles)) await expect(toggle).toBeVisible();
    // Left-to-right order of the four controls, read again until the resized bar settles.
    const leftToRight = async () => {
      const entries = await Promise.all(
        Object.entries(toggles).map(async ([name, toggle]) => [name, (await toggle.boundingBox())?.x] as const),
      );
      if (entries.some(([, left]) => left === undefined)) return [];
      return entries.sort(([, a], [, b]) => a! - b!).map(([name]) => name);
    };
    await expect.poll(leftToRight).toEqual(["quickView", "terminal", "more", "environment"]);
    // Narrow windows fold the individual tools into the menu but keep both toggles.
    for (const width of [680, 760]) {
      await aiden.app.evaluate(
        ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size, 800),
        width,
      );
      await expect(group.locator("[data-quick-view-toggle]")).toBeVisible();
      await expect(group.locator("[data-environment-toggle]")).toBeVisible();
    }
  });
  test("a tool covered by Quick View reads as not showing until it comes forward", async ({ aiden }) => {
    const { page } = aiden;
    await startPersistedChat(page);
    await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
    // 890px: Quick View no longer fits beside the floating tools (they stack), while
    // the collapsed-sidebar header is still wide enough for individual tool buttons.
    await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(890, 720));
    const files = page.locator('[data-workspace-tool="files"]');
    const tools = page.locator('[data-environment-surface="tools"]');
    await files.click();
    await expect(files).toHaveAttribute("aria-pressed", "true");
    await page.locator("[data-quick-view-toggle]").click();
    await expect(page.locator('[data-environment-stacked="true"]')).toHaveCount(1);
    await expect(tools).toHaveAttribute("inert", "");
    await expect(files).toHaveAttribute("aria-pressed", "false");

    // Pressing it brings the tools forward rather than closing what was hidden.
    await files.click();
    await expect(tools).not.toHaveAttribute("inert", "");
    await expect(files).toHaveAttribute("aria-pressed", "true");
  });
  test("history traversal keeps unsaved file edits until they are saved", async ({ aiden }) => {
    const { page } = aiden;
    const notes = path.join(aiden.workspaceDir, "notes.txt");
    await writeFile(notes, "original\n");
    await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    await startPersistedChat(page);
    const back = page.getByRole("button", { name: "Go back", exact: true });
    const forward = page.getByRole("button", { name: "Go forward", exact: true });
    const settingsNav = page.getByRole("navigation", { name: "Settings" });

    // Put a history entry outside the chat shell ahead of the chat.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(settingsNav).toBeVisible();
    await back.click();
    await expect(page.locator("[data-chat-title-menu]")).toBeVisible();
    await expect(forward).toBeEnabled();

    await page.locator('[data-workspace-tool="files"]').click();
    const panel = page.getByRole("complementary", { name: "Environment work surface" });
    await panel.getByRole("button", { name: "Refresh files" }).click();
    await panel.getByRole("button", { name: "notes.txt" }).click();
    const editor = panel.getByRole("textbox", { name: "Edit notes.txt" });
    await editor.fill("unsaved edit\n");

    await forward.click();
    await expect(page.getByText("Save or discard the open file's edits first")).toBeVisible();
    await expect(settingsNav).toHaveCount(0);
    await expect(editor).toHaveValue("unsaved edit\n");

    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => readFile(notes, "utf8")).toBe("unsaved edit\n");
    // Only once the save has settled (not merely started) may traversal leave the editor.
    await expect(panel.getByText("Saved", { exact: true })).toBeVisible();
    await forward.click();
    await expect(settingsNav).toBeVisible();
  });
});

test("a workspace without a folder keeps only folder-free tools", async ({ aiden }) => {
  const { page } = aiden;
  await startPersistedChat(page);
  await expect(page.locator('[data-workspace-tool="review"]')).toHaveCount(0);
  await expect(page.locator('[data-workspace-tool="files"]')).toHaveCount(0);
  await expect(page.locator('[data-workspace-tool="browser"]')).toBeVisible();
  // Nothing to act on without a folder, so the chip is a plain label, not a menu.
  const chip = page.locator("[data-workspace-chip]");
  await expect(chip).toBeVisible();
  await expect(chip).not.toHaveAttribute("aria-haspopup", "menu");
});

test("back and forward move through in-app navigation", async ({ aiden }) => {
  const { page } = aiden;
  await startPersistedChat(page);
  const back = page.getByRole("button", { name: "Go back", exact: true });
  const forward = page.getByRole("button", { name: "Go forward", exact: true });
  await expect(forward).toBeDisabled();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible();
  await expect(back).toBeEnabled();
  await back.click();
  await expect(page.locator("textarea")).toBeVisible();
  await expect(page.locator("[data-chat-title-menu]")).toBeVisible();
  await expect(forward).toBeEnabled();
  await forward.click();
  await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible();
  await expect(forward).toBeDisabled();
});

test("a collapsed sidebar keeps the title clear of the leading controls", async ({ aiden }) => {
  const { page } = aiden;
  await startPersistedChat(page);
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  const forward = page.getByRole("button", { name: "Go forward", exact: true });
  const title = page.locator("[data-chat-title-menu]");
  await expect(page.getByRole("button", { name: "Show sidebar", exact: true })).toBeVisible();
  // Wait for the header padding transition to settle before measuring.
  await expect.poll(async () => {
    const [controls, heading] = await Promise.all([forward.boundingBox(), title.boundingBox()]);
    return Boolean(controls && heading && heading.x >= controls.x + controls.width);
  }).toBe(true);
});

