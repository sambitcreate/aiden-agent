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

test("guided phone setup asks once, enables access, and survives closing the main window", async ({ aiden }, testInfo) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings" })
    .getByRole("button", { name: "Aiden On The Go", exact: true })
    .click();

  const choices = page.getByRole("radiogroup", { name: "Where will you use Aiden?" });
  const connect = page.getByRole("button", { name: "Connect a device", exact: true });
  // The field's label/content gap does not space children inside its content.
  // Guard the actual geometry so the CTA cannot touch the last choice card again.
  await expect(choices).toBeVisible();
  const choicesBox = await choices.boundingBox();
  const connectBox = await connect.boundingBox();
  expect(choicesBox).not.toBeNull();
  expect(connectBox).not.toBeNull();
  expect(connectBox!.y - (choicesBox!.y + choicesBox!.height)).toBeGreaterThanOrEqual(12);
  expect(connectBox!.x).toBe(choicesBox!.x);
  expect(connectBox!.width).toBeLessThan(choicesBox!.width);
  await page.getByRole("group", { name: "1. Connect your phone", exact: true })
    .screenshot({ path: testInfo.outputPath("phone-setup-spacing.png") });

  expect(await remoteStatus(page)).toMatchObject({ enabled: false, running: false });
  await page.getByRole("button", { name: "Connect a device", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Connect your phone to this Mac?" });
  await expect(review).toBeVisible();
  expect(await remoteStatus(page)).toMatchObject({ enabled: false, running: false });
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await remoteStatus(page)).toMatchObject({ enabled: false, running: false });
  await page.getByRole("button", { name: "Connect a device", exact: true }).click();
  await review.getByRole("button", { name: "Enable and show code", exact: true }).click();
  await expect(page.getByRole("img", { name: "One-time Aiden pairing QR code", exact: true })).toBeVisible();
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
