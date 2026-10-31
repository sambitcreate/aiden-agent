import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

// A paired Mac that supports project cloning, served from mocked host IPC:
// the e2e app has no second desktop to pair with.
const STUDIO = {
  id: "studio",
  name: "Mac Studio",
  enabled: true,
  state: "connected",
  features: ["workspace-clone-v1"],
  capabilities: ["workspace:manage", "workspace:browse"],
};

test("Add this project to another machine is offered only for a project folder, and starts with no environment file chosen", async ({ aiden }) => {
  const { page } = aiden;
  // HOME is the test root, so ~/widget resolves inside it.
  await mkdir(path.join(aiden.rootDir, "widget"));
  await finishLmStudioOnboarding(page);
  await aiden.app.evaluate(({ ipcMain }, host) => {
    const status = { hostId: host.id, generation: 1, state: { kind: "connected", since: Date.now() }, feed: "live", stale: false };
    const source = { name: "Widget", repositoryName: "widget", url: "https://example.invalid/widget.git", files: [{ name: ".env", bytes: 412 }, { name: ".dev.vars", bytes: 58 }] };
    const replace = (channel: string, answer: (...args: unknown[]) => unknown) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, ...args) => answer(...args));
    };
    replace("remote:peersList", () => [host]);
    replace("remote:peerHostStatuses", () => [status]);
    replace("remote:peerHostFeed", () => null);
    replace("workspaces:peerClonePreview", () => source);
    replace("remote:peerCall", (_hostId, raw) => {
      if ((raw as { operation: string }).operation === "roots") {
        return { ok: true, value: { roots: [{ id: "root", label: "Projects", location: "loc_root" }] } };
      }
      return { ok: false, error: { code: "not_found", message: "Not in this test." } };
    });
  }, STUDIO);
  await page.reload();
  const machine = page.getByRole("button", { name: /Choose where this chat runs/u });
  const addProject = page.getByRole("menuitem", { name: "Add this project to another machine…" });

  // A No workspace chat has no project folder to clone.
  await machine.click();
  await expect(page.getByRole("menuitemradio", { name: "Mac Studio" })).toBeVisible();
  await expect(addProject).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Move the draft into a project folder.
  await page.getByRole("button", { name: "Choose a workspace" }).click();
  const search = page.getByRole("combobox", { name: "Search workspaces" });
  await expect(search).toBeFocused();
  await search.fill("~/widget");
  await expect(page.getByRole("option", { name: /^Open \/.*widget/u })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(search).toHaveCount(0);

  await machine.click();
  await addProject.click();
  const dialog = page.getByRole("dialog", { name: "Add project to another machine" });
  await expect(dialog.getByRole("button", { name: "Projects" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Clone project" })).toBeDisabled();
  for (const name of [".env", ".dev.vars"]) {
    await expect(dialog.getByRole("checkbox", { name: new RegExp(`^\\${name}`, "u") })).not.toBeChecked();
  }
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});
