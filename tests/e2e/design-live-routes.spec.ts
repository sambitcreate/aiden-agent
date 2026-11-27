// Routes and route-aware placement end to end (design mode v2 Phase 3b,
// Task 13). The workspace is a copy of tests/fixtures/design-live-routes,
// which declares @tanstack/router-plugin so design mode lists its routes from
// src/routes/. Aiden's file writes come from the fake model's write_file and
// edit_file calls; the person's from Add ▸ Page from app….
//
// The saved canvas is the oracle for where frames went: each chat's page id
// is in `chatPages`, and each app frame carries its route.

import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import {
  appRoutesOn,
  chatIdFor,
  frameGroup,
  inside,
  LIVE_ON,
  openLiveChat,
  savedCanvas,
  seedFixture,
  shoot,
  startDesignChat,
} from "./design-live-helpers";
import { chooseWorkspace, designCanvas, sendFirstMessage, setDisplayWidth, setWindowWidth, typeSlashCommand, WORKSPACE_NAME } from "./design-mode-helpers";
import { expect, finishLmStudioOnboarding, test, waitForToastsToClear, type AidenE2e } from "./fixtures";

const ROUTES_FIXTURE = fileURLToPath(new URL("../fixtures/design-live-routes/", import.meta.url));
const PLAIN_FIXTURE = fileURLToPath(new URL("../fixtures/design-live-app/", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SAVE_ERROR = "The canvas couldn't save your latest changes.";
const UNDO = process.platform === "darwin" ? "Meta+z" : "Control+z";

const live = test.extend({
  appArgs: async ({ workspaceSeed: _seed }, use) => {
    // gVisor (the Cua Space) kills Chromium's seccomp-filtered renderer as soon
    // as a Vite + React page runs (3a's environment note). Test-only.
    await use(process.platform === "linux" ? ["--disable-seccomp-filter-sandbox"] : []);
  },
});

const addButton = (page: Page) => designCanvas(page).getByRole("button", { name: "Add", exact: true });
const picker = (page: Page) => page.getByRole("dialog", { name: "Add a page from your app" });
const filter = (page: Page) => picker(page).getByRole("combobox", { name: "Filter routes" });
const sidebarChat = (page: Page, title: string) =>
  page.locator("[data-sidebar]").getByRole("button", { name: new RegExp(`^${title}`, "u") }).first();

async function openPicker(page: Page): Promise<void> {
  await addButton(page).click();
  await page.getByRole("menuitem", { name: /^Page from app/u }).click();
  await expect(picker(page)).toBeVisible();
}

/** The page the chat claimed on the saved canvas. */
async function pageOf(aiden: AidenE2e, chatId: string): Promise<string> {
  await expect.poll(async () => (await savedCanvas(aiden.userDataDir))?.chatPages[chatId] ?? null).not.toBeNull();
  return (await savedCanvas(aiden.userDataDir))!.chatPages[chatId]!;
}

/** Runs one fake-model turn of tool calls in the chat on screen. */
async function turn(aiden: AidenE2e, prompt: string, calls: Array<{ name: string; arguments: Record<string, unknown> }>): Promise<void> {
  const composer = aiden.page.locator("textarea").first();
  const scenario = aiden.lmStudio.enqueueToolScenario!({ prompt, calls, finalText: "Done." });
  await composer.fill(prompt);
  await composer.press("Enter");
  await expect.poll(() => scenario.completed, { timeout: 30_000 }).toBe(true);
  expect(scenario.error).toBeUndefined();
}

const ABOUT = 'export default function About() {\n  return (\n    <main>\n      <h1>About</h1>\n    </main>\n  );\n}\n';

live.describe("with live apps on", () => {
  live.use({ workspaceSeed: true, appEnvironment: LIVE_ON });

  live("entering design mode shows the app's home, and Add ▸ Page from app places a route once, undoably", async ({ aiden }, testInfo) => {
    const { page, workspaceDir, userDataDir } = aiden;
    await seedFixture(workspaceDir, ROUTES_FIXTURE);
    const { chatId } = await openLiveChat(aiden);
    const pageId = await pageOf(aiden, chatId);

    // D. A chat that wrote nothing enters on the app's home.
    await expect.poll(() => appRoutesOn(userDataDir, pageId)).toEqual(["/"]);
    await expect(inside(page, "/").locator("#home-title")).toHaveText("Routes home", { timeout: 30_000 });

    // A. The Add menu offers a page of the app.
    await addButton(page).click();
    await expect(page.getByRole("menuitem")).toHaveCount(4);
    await expect(page.getByRole("menuitem", { name: /^Page from app/u })).toBeEnabled();
    await waitForToastsToClear(page);
    await shoot(page, testInfo, "design-live-add-menu");
    await page.keyboard.press("Escape");

    // The picker lists the app's files and canvas.json's filled route.
    await openPicker(page);
    const routes = picker(page).getByRole("listbox", { name: "Routes" });
    for (const route of ["/", "/pricing", "/blog/[slug]", "/blog/hello-world"]) {
      await expect(routes.getByRole("option").filter({ hasText: new RegExp(`^${route.replace(/[[\]/]/gu, "\\$&")}$`, "u") })).toHaveCount(1);
    }
    await expect(routes.getByRole("option")).toHaveCount(4);
    await expect(picker(page).getByText("From your app's files")).toBeVisible();
    // A dynamic row comes filled with canvas.json's value, and a typed address gets its own row.
    await filter(page).fill("/blog");
    await expect(routes.getByRole("textbox", { name: "slug" })).toHaveValue("hello-world");
    await expect(routes.getByRole("option", { name: /^Go to \/blog$/u })).toBeVisible();
    await shoot(page, testInfo, "design-live-route-picker");

    // Enter adds the route the filter narrowed to, live, on this chat's page.
    await filter(page).fill("pri");
    await filter(page).press("Enter");
    await expect(picker(page)).toBeHidden();
    await expect(inside(page, "/pricing").getByRole("heading", { name: "Pricing" })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => appRoutesOn(userDataDir, pageId)).toEqual(["/", "/pricing"]);
    expect((await savedCanvas(userDataDir))!.frames.find((frame) => frame.route === "/pricing")?.createdBy).toBe("person");

    // Adding it again finds the frame already there.
    await openPicker(page);
    await filter(page).fill("pri");
    await filter(page).press("Enter");
    await expect(picker(page)).toBeHidden();
    await expect(frameGroup(page, "/pricing")).toHaveCount(1);
    expect(await appRoutesOn(userDataDir, pageId)).toEqual(["/", "/pricing"]);

    // ⌘Z takes it off, and saving that undo works (B1): it isn't remembered as removed.
    await page.locator(".studio-canvas").focus();
    await page.keyboard.press(UNDO);
    await expect(frameGroup(page, "/pricing")).toHaveCount(0);
    await expect.poll(() => appRoutesOn(userDataDir, pageId)).toEqual(["/"]);
    expect((await savedCanvas(userDataDir))!.removedAppRoutes ?? []).toEqual([]);
    // The next edit saves too.
    await designCanvas(page).getByRole("button", { name: "Note", exact: true }).click();
    await expect.poll(async () => (await savedCanvas(userDataDir))!.frames.some((frame) => frame.kind === "note")).toBe(true);
    await expect(page.getByText(SAVE_ERROR)).toHaveCount(0);
    // The note goes again, so it stays out of the pictures.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Backspace");
    await expect.poll(async () => (await savedCanvas(userDataDir))!.frames.some((frame) => frame.kind === "note")).toBe(false);

    // Variants of the home (another frame of the same route takes duplicate), labelled in their headers, and a phone-size frame.
    const home = (await savedCanvas(userDataDir))!.frames.find((frame) => frame.kind === "app" && frame.route === "/")!;
    await turn(aiden, "Routes test: try two directions for the home and a phone pricing page.", [
      { name: "canvas_update_frame", arguments: { id: home.id, label: "Current" } },
      { name: "canvas_place_frame", arguments: { kind: "app", route: "/", title: "Home calm", variantOf: home.id, label: "Calm", duplicate: true } },
      { name: "canvas_place_frame", arguments: { kind: "app", route: "/", title: "Home bold", variantOf: home.id, label: "Bold", duplicate: true } },
      { name: "canvas_place_frame", arguments: { kind: "app", route: "/pricing", title: "Pricing phone", device: "phone" } },
    ]);
    const after = (await savedCanvas(userDataDir))!;
    const variants = after.frames.filter((frame) => frame.variantOf === home.id);
    expect(variants.map((frame) => frame.label).sort()).toEqual(["Bold", "Calm"]);
    const homeAfter = after.frames.find((frame) => frame.id === home.id)!;
    expect(homeAfter.groupId).toBeDefined();
    for (const variant of variants) expect(variant.groupId).toBe(homeAfter.groupId);
    expect(after.frames.find((frame) => frame.title === "Pricing phone")?.viewport).toEqual({ width: 390, height: 844 });
    for (const label of ["Current", "Calm", "Bold"]) await expect(designCanvas(page).getByText(label, { exact: true })).toBeVisible();
    await designCanvas(page).getByRole("button", { name: "Fit to screen" }).click();
    await expect(inside(page, "Pricing phone").getByRole("heading", { name: "Pricing" })).toBeVisible({ timeout: 30_000 });
    await waitForToastsToClear(page);
    await shoot(page, testInfo, "design-live-variants-phone");
  });

  live("a route file Aiden writes lands live, edits reload it in place, and a removed route stays off", async ({ aiden }, testInfo) => {
    const { page, workspaceDir, userDataDir } = aiden;
    await seedFixture(workspaceDir, ROUTES_FIXTURE);
    const { chatId } = await openLiveChat(aiden);
    const pageId = await pageOf(aiden, chatId);
    await expect.poll(() => appRoutesOn(userDataDir, pageId)).toEqual(["/"]);

    // B. A new route file is one live frame on the chat's page, focused.
    await turn(aiden, "Routes test: write the about page.", [{ name: "write_file", arguments: { path: "src/routes/about.tsx", content: ABOUT } }]);
    await expect.poll(() => appRoutesOn(userDataDir, pageId)).toEqual(["/", "/about"]);
    await expect(inside(page, "/about").getByRole("heading", { name: "About" })).toBeVisible({ timeout: 30_000 });
    expect((await savedCanvas(userDataDir))!.frames.find((frame) => frame.route === "/about")?.createdBy).toBe("aiden");
    await waitForToastsToClear(page);
    await shoot(page, testInfo, "design-live-written-route");

    // An edit of the same file changes the frame already there.
    await turn(aiden, "Routes test: retitle the about page.", [
      { name: "edit_file", arguments: { path: "src/routes/about.tsx", old_string: "<h1>About</h1>", new_string: "<h1>About us</h1>" } },
    ]);
    await expect(inside(page, "/about").getByRole("heading", { name: "About us" })).toBeVisible({ timeout: 30_000 });
    expect(await appRoutesOn(userDataDir, pageId)).toEqual(["/", "/about"]);

    // C. A component isn't a route: nothing new lands, and the home shows the change.
    await designCanvas(page).getByRole("button", { name: "Fit to screen" }).click();
    await turn(aiden, "Routes test: change the banner.", [
      { name: "edit_file", arguments: { path: "src/components/Banner.tsx", old_string: "Spring sale", new_string: "Summer sale" } },
    ]);
    await expect(inside(page, "/").locator("#banner")).toHaveText("Summer sale", { timeout: 30_000 });
    expect(await appRoutesOn(userDataDir, pageId)).toEqual(["/", "/about"]);

    // F. The person takes /about off; Aiden editing it again doesn't bring it back.
    await frameGroup(page, "/about").click();
    await page.keyboard.press("Backspace");
    await expect.poll(() => appRoutesOn(userDataDir, pageId)).toEqual(["/"]);
    expect((await savedCanvas(userDataDir))!.removedAppRoutes).toContain(".\u0000/about");
    await turn(aiden, "Routes test: tighten the about copy.", [
      { name: "edit_file", arguments: { path: "src/routes/about.tsx", old_string: "About us", new_string: "About the team" } },
    ]);
    await page.waitForTimeout(1_000);
    expect(await appRoutesOn(userDataDir, pageId)).toEqual(["/"]);
    await expect(frameGroup(page, "/about")).toHaveCount(0);
  });

  live("E: a route chat A writes while chat B's canvas is on screen lands on A's page only", async ({ aiden }) => {
    const { page, workspaceDir, userDataDir, lmStudio } = aiden;
    await seedFixture(workspaceDir, ROUTES_FIXTURE);
    const A_TITLE = "Design the pricing app";
    const B_TITLE = "Sketch the blog";
    const { chatId: chatA } = await openLiveChat(aiden, A_TITLE);
    const aPage = await pageOf(aiden, chatA);
    await page.getByRole("button", { name: "New Agent", exact: true }).click();
    const { chatId: chatB } = await startDesignChat(page, B_TITLE);
    const bPage = await pageOf(aiden, chatB);
    expect(bPage).not.toBe(aPage);
    await expect.poll(() => appRoutesOn(userDataDir, bPage)).toEqual(["/"]);

    // A's turn waits at the model while B's canvas comes back on screen.
    await sidebarChat(page, A_TITLE).click();
    await expect(designCanvas(page)).toBeVisible();
    const prompt = "Routes test: write the A page.";
    const scenario = lmStudio.enqueueToolScenario!({
      prompt,
      calls: [{ name: "write_file", arguments: { path: "src/routes/a.tsx", content: ABOUT.replace("About", "Page A") } }],
      finalText: "Done.",
    });
    lmStudio.holdCompletions!();
    const composer = page.locator("textarea").first();
    await composer.fill(prompt);
    await composer.press("Enter");
    await sidebarChat(page, B_TITLE).click();
    await expect(designCanvas(page).getByRole("button", { name: `Page: ${B_TITLE}` })).toBeVisible();
    lmStudio.releaseCompletions!();
    await expect.poll(() => scenario.completed, { timeout: 30_000 }).toBe(true);
    expect(scenario.error).toBeUndefined();

    await expect.poll(() => appRoutesOn(userDataDir, aPage)).toEqual(["/", "/a"]);
    expect(await appRoutesOn(userDataDir, bPage)).toEqual(["/"]);
    await expect(frameGroup(page, "/a")).toHaveCount(0);
  });

  live("the picker chooses between two apps, and says when an app's only route is /", async ({ aiden }, testInfo) => {
    const { app, page, workspaceDir } = aiden;
    // A workspace of two apps: the routes fixture and 3a's router-less app.
    await writeFile(path.join(workspaceDir, "package.json"), JSON.stringify({ name: "two-apps", private: true, workspaces: ["apps/*"] }, null, 2));
    await seedFixture(workspaceDir, ROUTES_FIXTURE, "apps/shop");
    await seedFixture(workspaceDir, PLAIN_FIXTURE, "apps/site");
    await symlink(path.join(REPOSITORY_ROOT, "node_modules"), path.join(workspaceDir, "node_modules"), "dir");
    await finishLmStudioOnboarding(page);
    await waitForToastsToClear(page);
    await setDisplayWidth(app, 1440);
    await setWindowWidth(app, page, 1440);
    await chooseWorkspace(page, new RegExp(`^${WORKSPACE_NAME}`, "u"));
    await sendFirstMessage(page, "Design the two apps");
    await chatIdFor(page, "Design the two apps");
    await typeSlashCommand(page, "/design");
    await expect(designCanvas(page)).toBeVisible();

    await openPicker(page);
    const which = picker(page).getByRole("combobox", { name: "App" });
    await expect(which).toBeVisible();
    await which.click();
    await expect(page.getByRole("option", { name: "design-live-routes-fixture" })).toBeVisible();
    await expect(page.getByRole("option", { name: "design-live-app-fixture" })).toBeVisible();
    await shoot(page, testInfo, "design-live-picker-two-apps");
    await page.getByRole("option", { name: "design-live-app-fixture" }).click();
    await expect(picker(page).getByText("Only / found: list routes in .aiden/canvas.json")).toBeVisible();
    await expect(picker(page).getByRole("listbox", { name: "Routes" }).getByRole("option")).toHaveCount(1);
    await shoot(page, testInfo, "design-live-picker-fallback");
  });
});

// G (M9.2). With live apps off, design mode is today's: three Add items, and a route write places nothing.
live.describe("with live apps off", () => {
  live.use({ workspaceSeed: true, appEnvironment: { AIDEN_EXPERIMENTAL_DESIGN_LIVE: "0" } });

  live("G: the Add menu has no Page from app, and a route file Aiden writes places nothing", async ({ aiden }) => {
    const { app, page, workspaceDir, userDataDir } = aiden;
    await seedFixture(workspaceDir, ROUTES_FIXTURE);
    await finishLmStudioOnboarding(page);
    await waitForToastsToClear(page);
    await setDisplayWidth(app, 1440);
    await setWindowWidth(app, page, 1440);
    await chooseWorkspace(page, new RegExp(`^${WORKSPACE_NAME}`, "u"));
    await sendFirstMessage(page, "Design the pricing app");
    await typeSlashCommand(page, "/design");
    await expect(designCanvas(page)).toBeVisible();

    await addButton(page).click();
    await expect(page.getByRole("menuitem")).toHaveCount(3);
    await expect(page.getByRole("menuitem", { name: /^Page from app/u })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await turn(aiden, "Routes test: write the about page with live apps off.", [
      { name: "write_file", arguments: { path: "src/routes/about.tsx", content: ABOUT } },
    ]);
    await page.waitForTimeout(1_000);
    expect(((await savedCanvas(userDataDir))?.frames ?? []).filter((frame) => frame.kind === "app")).toEqual([]);
    await expect(page.locator("iframe[data-app-frame-id]")).toHaveCount(0);
  });
});
