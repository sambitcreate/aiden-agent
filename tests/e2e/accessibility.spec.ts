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
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await waitForToastsToClear(page);
  const problems: string[] = [];

  await test.step("main chat window with the composer", async () => {
    problems.push(
      ...(await auditAccessibility(page, { surface: "chat window" })),
    );
    await expect(page.getByRole("main")).toMatchAriaSnapshot(`
      - main:
        - region "Conversation"
        - group "Composer workspace bar":
          - button "Choose a workspace"
        - textbox
        - button "Attach files or images"
        - 'button /^Selected model: .+\\. Choose a model\\.$/'
        - button "Send message" [disabled]
    `);
  });

  await test.step("model picker popover", async () => {
    await page.getByRole("button", { name: /^Selected model:/u }).click();
    await page.getByRole("tab", { name: "List" }).click();
    const picker = page
      .getByRole("dialog")
      .filter({
        has: page.getByRole("tablist", { name: "Model picker view" }),
      });
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
      - dialog:
        - tablist "Model picker view":
          - tab "List" [selected]
          - tab "Personal Model Pad"
        - tabpanel "List":
          - combobox "Chat model" [expanded]
          - listbox "Suggestions":
            - option [selected]
    `);
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

  expect(problems).toEqual([]);
});
