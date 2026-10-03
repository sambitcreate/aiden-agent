import { generateKeyPairSync, randomBytes } from "node:crypto";
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
    .getByRole("button", { name: "Connections", exact: true })
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
  const review = page.getByRole("dialog", { name: `Connect your phone to this ${process.platform === "darwin" ? "Mac" : "computer"}?` });
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

async function hostRequest(
  port: number,
  method: "GET" | "POST" | "DELETE",
  path: string,
  options: { secret?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = https.request(
      `https://127.0.0.1:${port}/api/aiden/v1${path}`,
      {
        method,
        rejectUnauthorized: false,
        timeout: 5_000,
        headers: {
          ...(payload ? { "content-type": "application/json" } : {}),
          ...(options.secret ? { "aiden-pairing-secret": options.secret } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once("error", reject);
    request.end(payload);
  });
}

/** Ask the host to pair as another desktop and reveal, so the host shows its sheet. */
async function openConnectionRequest(
  port: number,
  deviceName: string,
): Promise<{ requestId: string; pollSecret: string }> {
  const publicKey = generateKeyPairSync("x25519").publicKey.export({ format: "jwk" }).x;
  const created = await hostRequest(port, "POST", "/pairing/requests", {
    body: { deviceName, deviceType: "mac", publicKey },
  });
  expect(created.status).toBe(201);
  const requestId = String(created.body.requestId);
  const pollSecret = String(created.body.pollSecret);
  const revealed = await hostRequest(port, "POST", `/pairing/requests/${requestId}/reveal`, {
    secret: pollSecret,
    body: { requesterNonce: randomBytes(32).toString("base64url") },
  });
  expect(revealed.status).toBe(200);
  return { requestId, pollSecret };
}

test("a connection request that replaces the one on screen starts back on Deny", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await page.evaluate(async () => {
    const bridge = (window as unknown as {
      aidenAPI: { ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } };
    }).aidenAPI;
    await bridge.ipc.invoke("remote:setEnabled", true);
  });
  await expect.poll(async () => (await remoteStatus(page)).running).toBe(true);
  const { lanPort } = await remoteStatus(page);

  const first = await openConnectionRequest(lanPort, "First Mac");
  const second = await openConnectionRequest(lanPort, "Second Mac");
  const firstSheet = page.getByRole("dialog", { name: /^First Mac wants to control this / });
  await expect(firstSheet).toBeVisible();
  await expect(firstSheet.getByRole("button", { name: "Deny", exact: true })).toBeFocused();

  // The person compares the first code and moves to Allow, then that requester gives up.
  const allow = firstSheet.getByRole("button", { name: "Allow", exact: true });
  await expect(allow).toBeEnabled();
  await allow.focus();
  await expect(allow).toBeFocused();
  const cancelled = await hostRequest(lanPort, "DELETE", `/pairing/requests/${first.requestId}`, {
    secret: first.pollSecret,
  });
  expect(cancelled.body).toMatchObject({ state: "cancelled" });

  // The next device must not inherit the focused Allow: Enter now denies it.
  const secondSheet = page.getByRole("dialog", { name: /^Second Mac wants to control this / });
  await expect(secondSheet).toBeVisible();
  await expect(secondSheet.getByRole("button", { name: "Deny", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(secondSheet).toBeHidden();
  const outcome = await hostRequest(lanPort, "GET", `/pairing/requests/${second.requestId}`, {
    secret: second.pollSecret,
  });
  expect(outcome.body).toMatchObject({ state: "denied" });
  expect(outcome.body).not.toHaveProperty("envelope");
});

test("adding another computer by setup code reports an unreachable address and returns to the form", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings" })
    .getByRole("button", { name: "Connections", exact: true })
    .click();

  const segments = page.getByRole("tablist", { name: "Connections" });
  const thisDevice = segments.getByRole("tab", { name: "Control this device", exact: true });
  await expect(thisDevice).toHaveAttribute("aria-selected", "true");
  await thisDevice.focus();
  await page.keyboard.press("ArrowRight");
  const otherDevices = segments.getByRole("tab", { name: "Control other devices", exact: true });
  await expect(otherDevices).toBeFocused();
  await expect(otherDevices).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("No computers yet", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add device", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Add device" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Enter setup code", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Enter setup code" });
  const address = form.getByRole("textbox", { name: "Desktop address" });
  await expect(address).toBeFocused();
  const pair = form.getByRole("button", { name: "Pair", exact: true });
  await expect(pair).toBeDisabled();

  // Nothing listens on port 1, so the attempt fails without leaving this machine.
  await address.fill("127.0.0.1:1");
  await form.getByRole("textbox", { name: "Setup code" }).fill("ABCD-EFGH-JKLM");
  await pair.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Enter setup code" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("No computers yet", { exact: true })).toBeVisible();
});

function assertHealth(result: { status: number; body: unknown }): void {
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ ok: true, protocolVersion: 1 });
}
