import https from "node:https";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

async function remoteHealth(): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      "https://127.0.0.1:49220/api/aiden/v1/health",
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
  await expect(remoteHealth()).rejects.toThrow();
  await enabled.click();
  await expect(enabled).toHaveAttribute("data-state", "checked");
  await expect(
    page.getByRole("group").filter({ has: enabled })
      .getByText("Ready for a device", { exact: true }),
  ).toBeVisible();
  assertHealth(await remoteHealth());

  await page.close();
  assertHealth(await remoteHealth());
});

function assertHealth(result: { status: number; body: unknown }): void {
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ ok: true, protocolVersion: 1 });
}
