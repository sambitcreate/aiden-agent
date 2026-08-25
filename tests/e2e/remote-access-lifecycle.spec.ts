import https from "node:https";
import type { Page } from "@playwright/test";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

type RemoteRuntimeStatus = {
  enabled: boolean;
  running: boolean;
  lanPort: number;
};

async function remoteStatus(page: Page): Promise<RemoteRuntimeStatus> {
  return page.evaluate(async () => {
    const bridge = (window as unknown as {
      aidenAPI: { ipc: { invoke(channel: string): Promise<unknown> } };
    }).aidenAPI;
    const snapshot = await bridge.ipc.invoke("remote:get") as {
      status: RemoteRuntimeStatus;
    };
    return snapshot.status;
  });
}

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

test("Remote Access is opt-in and remains available after the main window closes", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings" })
    .getByRole("button", { name: "Remote Access", exact: true })
    .click();

  const enabled = page.getByRole("switch", { name: "Enable Aiden Remote Access" });
  await expect(enabled).toHaveAttribute("data-state", "unchecked");
  expect(await remoteStatus(page)).toMatchObject({ enabled: false, running: false });
  await enabled.click();
  await expect(enabled).toHaveAttribute("data-state", "checked");
  await expect(
    page.getByRole("group").filter({ has: enabled })
      .getByText("Ready for a device", { exact: true }),
  ).toBeVisible();
  const running = await remoteStatus(page);
  expect(running).toMatchObject({ enabled: true, running: true });
  assertHealth(await remoteHealth(running.lanPort));

  await page.close();
  assertHealth(await remoteHealth(running.lanPort));
});

function assertHealth(result: { status: number; body: unknown }): void {
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ ok: true, protocolVersion: 1 });
}
