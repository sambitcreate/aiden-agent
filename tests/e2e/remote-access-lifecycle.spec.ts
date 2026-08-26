import https from "node:https";
import type { Page } from "@playwright/test";
import type { AidenRemoteSettingsSnapshot } from "../../renderer/shared/aiden-remote";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

async function remoteHealth(port: number): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      `https://127.0.0.1:${port}/api/aiden/v1/health`,
      { rejectUnauthorized: false, timeout: 3_000 },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once("error", reject);
  });
}

async function remoteSnapshot(page: Page): Promise<AidenRemoteSettingsSnapshot> {
  return page.evaluate(() => {
    const bridgeWindow = window as typeof window & {
      aidenAPI: {
        ipc: {
          invoke<T>(channel: string, ...args: unknown[]): Promise<T>;
        };
      };
    };
    return bridgeWindow.aidenAPI.ipc.invoke<AidenRemoteSettingsSnapshot>("remote:get");
  });
}

async function expectRemoteHealth(port: number): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          return await remoteHealth(port);
        } catch (error) {
          return {
            status: 0,
            body: error instanceof Error ? error.message : String(error),
          };
        }
      },
      { intervals: [100, 250, 500], timeout: 10_000 },
    )
    .toEqual({ status: 200, body: { ok: true, protocolVersion: 1 } });
}

test("Remote Access is opt-in and remains available after the main window closes", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings" })
    .getByRole("button", { name: "Remote Access", exact: true })
    .click();

  const enabled = page.getByRole("switch", { name: "Enable Aiden Remote Access" });
  await expect(enabled).toHaveAttribute("data-state", "unchecked");
  expect((await remoteSnapshot(page)).status.running).toBe(false);
  await enabled.click();
  await expect(enabled).toHaveAttribute("data-state", "checked");
  await expect(
    page.getByRole("group").filter({ has: enabled })
      .getByText("Ready for a device", { exact: true }),
  ).toBeVisible();
  const port = (await remoteSnapshot(page)).status.lanPort;
  await expectRemoteHealth(port);

  await page.close();
  await expectRemoteHealth(port);
});
