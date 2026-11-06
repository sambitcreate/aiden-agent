import type { CDPSession } from "@playwright/test";
import { AidenAppControlProvider, type AidenWindowPort } from "../../main/services/gemini-live/app-control/provider";
import type { LiveRendererToolBroker } from "../../main/services/gemini-live/live-tools";
import type { RendererDocumentOwner } from "../../main/services/renderer-document-owner";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

// Live's app-control provider against the real Aiden window: the same
// DevTools calls main makes over webContents.debugger go through a CDP
// session on the page, so this reads the real accessibility tree and acts on
// the real DOM. The Live session and the renderer's admission are stubbed.

function cdpPort(session: CDPSession, onNavigate: (listener: () => void) => () => void): AidenWindowPort {
  return {
    call: (method, params) => session.send(method as never, params as never),
    onNavigate,
    close: () => undefined,
  };
}

function admittingRenderer(): Pick<LiveRendererToolBroker, "request"> {
  return {
    request: async (_name, args, signal) => {
      if (args.op === "watch") {
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        return { ok: true, ended: true };
      }
      if (args.op === "confirm") return { ok: true, confirmed: false, reason: "cancelled" };
      return { ok: true };
    },
  };
}

test("Live finds Settings in Aiden's real window, presses its way to Aiden Live, and can't flip its own switch", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  const session = await page.context().newCDPSession(page);
  const provider = new AidenAppControlProvider({
    port: cdpPort(session, (listener) => {
      page.on("framenavigated", listener);
      return () => page.off("framenavigated", listener);
    }),
    renderer: admittingRenderer(),
    open: async () => ({ status: "unavailable" }),
    idleMs: 1,
  });
  let id = 0;
  const call = (name: string, args: Record<string, unknown> = {}) =>
    provider.handle(
      { id: `c${++id}`, name, args },
      { sessionId: "e2e", owner: {} as RendererDocumentOwner, signal: new AbortController().signal },
    );
  const numberOf = (screen: unknown, pattern: RegExp) => {
    const line = String(screen)
      .split("\n")
      .find((entry) => /^\d+ /u.test(entry) && pattern.test(entry));
    expect(line, `${pattern} in:\n${String(screen)}`).toBeTruthy();
    return Number(line!.split(" ")[0]);
  };
  try {
    const home = await call("look_at_aiden");
    expect(home.ok).toBe(true);
    // The composer's workspace access picker is the user's alone.
    numberOf(home.screen, /button “Workspace access: [^”]*”.*\(only you can use this\)/u);
    const settings = await call("use_aiden", { element: numberOf(home.screen, /^\d+ button “Settings”/u), action: "press" });
    expect(settings.ok).toBe(true);
    await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible();

    const voice = await call("use_aiden", { element: numberOf(settings.screen, /button “Voice & Speech”/u), action: "press" });
    const liveTab = await call("use_aiden", { element: numberOf(voice.screen, /tab “Aiden Live”/u), action: "press" });
    const liveSwitch = page.getByRole("switch", { name: "Let Live move through Aiden" });
    await expect(liveSwitch).toBeChecked();

    const look = await call("look_at_aiden", { focus: "In Aiden" });
    const switchNumber = numberOf(look.screen, /switch “Let Live move through Aiden” \(checked\) \(only you can use this\)/u);
    expect(String(liveTab.screen)).toContain("(only you can use this)");
    const refused = await call("use_aiden", { element: switchNumber, action: "toggle" });
    expect(refused.error).toEqual({ code: "user_only", message: "Only the user can use this. Ask them to do it themselves." });
    await expect(liveSwitch).toBeChecked();
  } finally {
    provider.close();
    await session.detach().catch(() => undefined);
  }
});
