import { auditAccessibility } from "./axe-gate";
import {
  expect,
  finishLmStudioOnboarding,
  test,
  waitForToastsToClear,
  type AidenE2e,
} from "./fixtures";

const PRIMARY_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

async function seedChat({ app, page }: AidenE2e): Promise<void> {
  const workspaceId = await page.evaluate(() =>
    localStorage.getItem("aiden-agent.workspaceId"),
  );
  expect(workspaceId).toBeTruthy();
  await app.evaluate(({ ipcMain }, workspaceId) => {
    const chat = {
      id: "a11y-chat",
      workspaceId,
      title: "Accessibility chat",
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
      messages: [
        {
          id: "a11y-message",
          role: "user",
          content: "Audit me",
          createdAt: 1_800_000_000_000,
        },
      ],
    };
    ipcMain.removeHandler("chats:list");
    ipcMain.handle("chats:list", () => [chat]);
    ipcMain.removeHandler("chats:get");
    ipcMain.handle("chats:get", (_event, id) => ({
      chat: id === chat.id ? chat : null,
      imageArtifactRecoveryPending: false,
      imageArtifactRecoveryUnavailable: false,
      reconciliation: null,
    }));
  }, workspaceId);
  await page.reload();
  await expect(page.locator("textarea")).toBeVisible();
}

// One launch walks every surface; axe problems are collected so one failing
// surface still reports the others. Exclusions live in axe-gate.ts.
test("core surfaces pass the WCAG A/AA axe gate and keep their accessible structure", async ({
  aiden,
}) => {
  const { page, app } = aiden;
  await finishLmStudioOnboarding(page);
  await waitForToastsToClear(page);
  const problems: string[] = [];

  await test.step("main chat window with the composer", async () => {
    problems.push(
      ...(await auditAccessibility(page, { surface: "chat window" })),
    );
    // An empty draft shows Aiden Live in Send's place on macOS and Linux.
    await expect(page.getByRole("main")).toMatchAriaSnapshot(`
      - main:
        - region "Conversation"
        - group "Composer workspace bar":
          - 'button /^.+\\. Choose a workspace\\.$/'
        - textbox
        - button "Attach files or images"
        - 'button /^Selected model: .+\\. Choose a model\\.$/'
        - button "Set up Aiden Live"
    `);
  });

  await test.step("model picker popover", async () => {
    await page.getByRole("button", { name: /^Selected model:/u }).click();
    const picker = page.getByRole("dialog", { name: "Choose agent" });
    await expect(picker.getByRole("slider", { name: "Agent Slider" })).toBeFocused();
    problems.push(
      ...(await auditAccessibility(page, {
        surface: "agent slider",
        include: "[data-radix-popper-content-wrapper]",
      })),
    );
    await expect(picker).toMatchAriaSnapshot(`
      - dialog "Choose agent":
        - button /^Reset to /
        - slider "Agent Slider"
        - list "Stops without a model to run"
        - separator
        - button /^Other models…/
        - button "Customize slider…"
    `);
    await picker.getByRole("button", { name: /^Other models…/u }).click();
    await expect(
      picker.getByRole("combobox", { name: "Chat model" }),
    ).toBeFocused();
    problems.push(
      ...(await auditAccessibility(page, {
        surface: "model picker",
        include: "[data-radix-popper-content-wrapper]",
      })),
    );
    await expect(picker).toMatchAriaSnapshot(`
      - dialog "Choose agent":
        - button "Back to slider"
        - heading "Other models" [level=3]
        - region "Other models":
          - combobox "Chat model" [expanded]
          - listbox "Suggestions":
            - option [selected]
    `);
    // Escape returns to the slider first, then closes the popover.
    await page.keyboard.press("Escape");
    await expect(picker.getByRole("slider", { name: "Agent Slider" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
  });

  await test.step("command palette", async () => {
    await page.keyboard.press(`${PRIMARY_MODIFIER}+K`);
    const palette = page.getByRole("dialog", { name: "Commands" });
    await expect(
      palette.getByRole("combobox", { name: "Search commands" }),
    ).toBeFocused();
    problems.push(
      ...(await auditAccessibility(page, {
        surface: "command palette",
        include: "[data-command-palette-content]",
      })),
    );
    await expect(palette).toMatchAriaSnapshot(`
      - dialog "Commands":
        - combobox "Search commands" [expanded]
        - listbox "Suggestions":
          - option
    `);
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });

  await test.step("confirm dialog", async () => {
    await seedChat(aiden);
    await page
      .locator("aside button", { hasText: "Accessibility chat" })
      .click();
    await expect(page.getByText("Audit me", { exact: true })).toBeVisible();
    await page.keyboard.press(`${PRIMARY_MODIFIER}+K`);
    const search = page.getByRole("combobox", { name: "Search commands" });
    await search.fill("Delete chat");
    await search.press("Enter");
    const confirm = page.getByRole("alertdialog", {
      name: "Delete this chat?",
    });
    await expect(confirm).toBeVisible();
    problems.push(
      ...(await auditAccessibility(page, {
        surface: "confirm dialog",
        include: "[role=alertdialog]",
      })),
    );
    await expect(confirm).toMatchAriaSnapshot(`
      - alertdialog "Delete this chat?":
        - heading "Delete this chat?" [level=2]
        - button "Cancel"
        - button "Delete"
    `);
    await page.keyboard.press("Escape");
    await expect(confirm).toBeHidden();
  });

  await test.step("settings: Providers and Appearance", async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const navigation = page.getByRole("navigation", { name: "Settings" });
    await navigation
      .getByRole("button", { name: "Providers", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Your connections" }),
    ).toBeVisible();
    problems.push(
      ...(await auditAccessibility(page, { surface: "settings providers" })),
    );
    await expect(navigation).toMatchAriaSnapshot(`
      - navigation "Settings":
        - button "Providers"
        - button "Appearance"
    `);
    await expect(page.getByRole("main")).toMatchAriaSnapshot(`
      - main:
        - heading "Providers" [level=1]
        - heading "Your connections" [level=2]
        - button "Connect another AI"
    `);

    await navigation
      .getByRole("button", { name: "Appearance", exact: true })
      .click();
    await expect(
      page.getByRole("radiogroup", { name: "Themes", exact: true }),
    ).toBeVisible();
    problems.push(
      ...(await auditAccessibility(page, { surface: "settings appearance" })),
    );
    await expect(page.getByRole("region", { name: "Theme" }))
      .toMatchAriaSnapshot(`
      - region "Theme":
        - heading "Theme" [level=2]
        - radiogroup "Theme mode":
          - radio "System" [checked]
          - radio "Light"
          - radio "Dark"
        - radiogroup "Themes":
          - radio "Aiden" [checked]
    `);
  });

  await test.step("settings: Agent Slider editor at narrow and wide widths", async () => {
    const navigation = page.getByRole("navigation", { name: "Settings" });
    await navigation
      .getByRole("button", { name: "Agent Slider", exact: true })
      .click();
    for (const [label, width, height] of [
      ["wide", 1280, 800],
      ["narrow", 600, 720],
    ] as const) {
      await app.evaluate(
        ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
        },
        { width, height },
      );
      await expect(
        page.getByRole("slider", { name: "Agent Slider" }),
      ).toBeVisible();
      problems.push(
        ...(await auditAccessibility(page, {
          surface: `settings agent slider (${label})`,
        })),
      );
      // Onboarding seeded Fast / Balanced (the connected model, home) / Smart.
      await expect(page.getByRole("main")).toMatchAriaSnapshot(`
        - main:
          - heading "Agent Slider" [level=1]
          - heading "Preview" [level=2]
          - button "Templates"
          - slider "Agent Slider"
          - heading "Stops" [level=2]
          - radiogroup "Home stop":
            - list "Slider stops, left to right":
              - listitem:
                - 'radio "Home stop: Fast"'
                - textbox "Name of stop 1"
                - button "Move Fast up"
                - button "Move Fast down"
                - button "Remove Fast"
                - button "Choose a model for Fast"
              - listitem:
                - 'radio "Home stop: Balanced" [checked]'
                - textbox "Name of stop 2"
              - listitem:
                - 'radio "Home stop: Smart"'
                - textbox "Name of stop 3"
          - button "Add stop"
      `);
    }
  });

  expect(problems).toEqual([]);
});
