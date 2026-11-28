import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  BrowserCommand,
  BrowserCommandResult,
  BrowserState,
} from "../../renderer/shared/browser";
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
  const workspaceId = await page.evaluate(() => localStorage.getItem("aiden-agent.workspaceId"));
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
    problems.push(...(await auditAccessibility(page, { surface: "chat window" })));
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
    await expect(picker.getByRole("combobox", { name: "Chat model" })).toBeFocused();
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
    await expect(palette.getByRole("combobox", { name: "Search commands" })).toBeFocused();
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
    await page.locator("aside button", { hasText: "Accessibility chat" }).click();
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

  await test.step("browser grab chip & inspection popover", async () => {
    const workspaceId = await page.evaluate(() => localStorage.getItem("aiden-agent.workspaceId"));
    expect(workspaceId).toBeTruthy();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><html><head><title>Grab a11y fixture</title></head><body style="padding:24px;font:16px system-ui"><button id="hero-btn" type="button" style="padding:10px 16px">Launch</button><script>function HeroBanner(){}const btn=document.getElementById('hero-btn');btn['__reactFiber$a11y']={tag:5,type:'button',stateNode:btn,return:{tag:0,type:HeroBanner,_debugSource:{fileName:'/src/HeroBanner.tsx',lineNumber:10,columnNumber:2},return:null}};</script></body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    type BrowserTestWindow = Window & {
      aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } };
    };
    const browserCommand = (input: BrowserCommand) =>
      page.evaluate(
        ({ id, cmd }) =>
          (window as unknown as BrowserTestWindow).aidenAPI.ipc.invoke<BrowserCommandResult>(
            "browser:command",
            id,
            cmd,
          ),
        { id: workspaceId!, cmd: input },
      );
    const browserState = () =>
      page.evaluate(
        (id) =>
          (window as unknown as BrowserTestWindow).aidenAPI.ipc.invoke<BrowserState>(
            "browser:get-state",
            id,
          ),
        workspaceId!,
      );
    let tabId: string | undefined;
    try {
      await page.getByRole("button", { name: "Show Environment" }).click();
      const surface = page.getByRole("complementary", { name: "Environment work surface" });
      await surface.getByRole("button", { name: "Browser", exact: true }).click();
      const opened = await browserCommand({ action: "create", url });
      tabId = opened.state.activeTabId!;
      await expect
        .poll(async () => (await browserState()).tabs.find((tab) => tab.id === tabId)?.title)
        .toBe("Grab a11y fixture");
      await expect
        .poll(async () => (await browserState()).tabs.find((tab) => tab.id === tabId)?.visible)
        .toBe(true);

      await surface.getByRole("button", { name: "Grab element", exact: true }).click();
      await expect
        .poll(async () => (await browserState()).tabs.find((tab) => tab.id === tabId)?.grabbing)
        .toBe(true);
      await aiden.app.evaluate(async ({ webContents }, guestUrl) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().startsWith(guestUrl));
        if (!guest) throw new Error("Browser guest missing");
        const point = (await guest.executeJavaScript(
          "(() => { const r = document.getElementById('hero-btn').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()",
        )) as { x: number; y: number };
        guest.focus();
        guest.sendInputEvent({ type: "mouseMove", ...point });
        await new Promise((resolve) => setTimeout(resolve, 40));
        guest.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
        guest.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
      }, url);
      await expect
        .poll(async () => (await browserState()).tabs.find((tab) => tab.id === tabId)?.grabbing)
        .toBe(false);
      await page.getByRole("button", { name: "Close environment panel", exact: true }).click();
      await expect(surface).toBeHidden();

      const trigger = page.locator("[data-grabbed-element-trigger]").first();
      await expect(trigger).toBeVisible();
      problems.push(
        ...(await auditAccessibility(page, {
          surface: "browser grab chip",
          include: "[data-grabbed-element-chip]",
        })),
      );

      await trigger.click();
      const popover = page.getByRole("dialog", { name: "Included with your message" });
      await expect(popover).toBeVisible();
      await popover.locator("[data-grabbed-element-details-toggle]").click();
      await expect(popover.locator("[data-grabbed-element-details-toggle]")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      problems.push(
        ...(await auditAccessibility(page, {
          surface: "browser grab inspection popover",
          include: "[data-grabbed-element-popover]",
        })),
      );
      await expect(popover).toMatchAriaSnapshot(`
        - dialog "Included with your message":
          - button "Copy element context"
          - button "Hide details" [expanded]
      `);

      await page.keyboard.press("Escape");
      await expect(popover).toBeHidden();
      await page.locator("[data-grabbed-element-remove]").first().click();
      await expect(page.locator("[data-grabbed-element-chip]")).toHaveCount(0);
    } finally {
      if (tabId) await browserCommand({ action: "close", tabId }).catch(() => undefined);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  await test.step("settings: Providers and Appearance", async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const navigation = page.getByRole("navigation", { name: "Settings" });
    await navigation.getByRole("button", { name: "Providers", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your connections" })).toBeVisible();
    problems.push(...(await auditAccessibility(page, { surface: "settings providers" })));
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

    await navigation.getByRole("button", { name: "Appearance", exact: true }).click();
    await expect(page.getByRole("radiogroup", { name: "Themes", exact: true })).toBeVisible();
    problems.push(...(await auditAccessibility(page, { surface: "settings appearance" })));
    await expect(page.getByRole("region", { name: "Theme" })).toMatchAriaSnapshot(`
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
    await navigation.getByRole("button", { name: "Agent Slider", exact: true }).click();
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
      await expect(page.getByRole("slider", { name: "Agent Slider" })).toBeVisible();
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
