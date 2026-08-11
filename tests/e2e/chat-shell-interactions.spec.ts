import { expect, finishLmStudioOnboarding, test } from "./fixtures";

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
  await expect(slashCommands.getByRole("option").filter({ hasText: "/model" })).toBeVisible();
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

  const environment = page.getByRole("button", { name: "Show environment" });
  const environmentSummary = page.getByRole("complementary", {
    name: "Environment summary",
  });
  await expect(environment).toHaveAttribute("aria-pressed", "false");
  await environment.click();
  await expect(environmentSummary).toBeVisible();
  await expect(environmentSummary.getByText("No workspace folder", { exact: true })).toBeVisible();
  await expect(
    environmentSummary.getByText(
      "Choose a local workspace to see its environment, changes, and branch.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide environment" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Hide environment" }).click();
  await expect(environmentSummary).toBeHidden();

  const terminal = page.getByRole("button", { name: "Show terminal" });
  await expect(terminal).toBeDisabled();
  await expect(terminal).toHaveAttribute("aria-pressed", "false");

  const permission = page.getByRole("button", {
    name: /^Workspace access: Ask first/u,
  });
  await permission.click();
  const noAccess = page.getByRole("menuitemcheckbox", { name: "No access" });
  await expect(noAccess).toHaveAttribute("aria-checked", "false");
  await noAccess.click();
  await expect(page.getByRole("button", { name: /^Workspace access: No access/u })).toBeVisible();
  await page.getByRole("button", { name: /^Workspace access: No access/u }).click();
  await page.getByRole("menuitemcheckbox", { name: "Ask first" }).click();
  await expect(permission).toBeVisible();

  await composer.fill("Draft and attachment stay with this chat only.");
  await pasteImage(page);
  await page.getByRole("button", { name: `Remove ${PASTED_IMAGE_NAME}` }).click();
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
  const visibleSidebarToggle = page.getByRole("button", { name: "Hide sidebar" });
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
