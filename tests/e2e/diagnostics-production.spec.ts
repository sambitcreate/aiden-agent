import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, finishLmStudioOnboarding, test } from "./fixtures";

const gunzipAsync = promisify(gunzip);

test("production profile retains, exports, and deletes only bounded local diagnostics", async ({ aiden }) => {
  test.skip(process.env.AIDEN_E2E_RUNTIME_PROFILE !== "production", "production-profile acceptance only");
  const { page, app, userDataDir, rootDir } = aiden;
  await finishLmStudioOnboarding(page);
  const logs = path.join(userDataDir, "logs");
  const journal = path.join(logs, "aiden.log");
  await expect.poll(async () => (await readFile(journal, "utf8")).includes('"profile":"production"')).toBe(true);

  await page.evaluate(() => {
    window.dispatchEvent(new ErrorEvent("error", { error: new TypeError("renderer-private-message") }));
  });
  await expect.poll(async () => (await readFile(journal, "utf8")).includes("renderer-global-error")).toBe(true);
  expect(await readFile(journal, "utf8")).not.toContain("renderer-private-message");

  const destination = path.join(rootDir, "production-diagnostics.json.gz");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, destination);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "About", exact: true }).click();
  await page.getByRole("button", { name: "Export…", exact: true }).click();
  await expect(page.getByText("Diagnostics exported. Aiden did not send the file anywhere.")).toBeVisible();
  expect((await stat(destination)).mode & 0o777).toBe(0o600);
  const bundle = JSON.parse((await gunzipAsync(await readFile(destination))).toString("utf8")) as {
    manifest: { app: { runtimeProfile: string }; included: { generalRecords: number } };
  };
  expect(bundle.manifest.app.runtimeProfile).toBe("production");
  expect(bundle.manifest.included.generalRecords).toBeGreaterThan(0);

  const neighbor = path.join(logs, "settings.json");
  await writeFile(neighbor, "keep", { mode: 0o600 });
  await page.getByRole("button", { name: "Delete…", exact: true }).click();
  await page.getByRole("button", { name: "Delete diagnostic data", exact: true }).click();
  await expect(page.getByText("Local diagnostic data deleted.")).toBeVisible();
  expect(await readFile(neighbor, "utf8")).toBe("keep");
});
