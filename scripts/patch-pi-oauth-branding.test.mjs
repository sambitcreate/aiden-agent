/* global fetch */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { patchPiOAuthBranding } from "./patch-pi-oauth-branding.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-oauth-branding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "node_modules", "@earendil-works", "pi-ai");
  const oauthRoot = path.join(packageRoot, "dist", "auth", "oauth");
  await mkdir(path.join(root, "resources"), { recursive: true });
  await mkdir(oauthRoot, { recursive: true });
  await mkdir(path.join(packageRoot, "dist", "utils"), { recursive: true });
  await copyFile(
    path.join(repositoryRoot, "resources", "app-icon.png"),
    path.join(root, "resources", "app-icon.png"),
  );
  for (const relativePath of [
    "package.json",
    path.join("dist", "utils", "oauth-page.js"),
    path.join("dist", "auth", "oauth", "callback-server.js"),
    path.join("dist", "auth", "oauth", "openai-chatgpt.js"),
  ]) {
    await copyFile(
      path.join(repositoryRoot, "node_modules", "@earendil-works", "pi-ai", relativePath),
      path.join(packageRoot, relativePath),
    );
  }
  return { packageRoot, root };
}

test("brands Pi OAuth callbacks as Aiden and remains idempotent", async (t) => {
  const { packageRoot, root } = await fixture(t);
  await patchPiOAuthBranding(root);
  assert.deepEqual(await patchPiOAuthBranding(root), { changed: false });

  const pagePath = path.join(packageRoot, "dist", "utils", "oauth-page.js");
  const page = await import(pathToFileURL(pagePath).href);
  const success = page.oauthSuccessHtml("Connected account");
  const failure = page.oauthErrorHtml("Denied", "Retry sign-in");
  assert.match(success, /<title>Aiden Agent sign-in successful<\/title>/u);
  assert.match(success, /Connected account/u);
  assert.match(success, /data:image\/png;base64,/u);
  assert.match(failure, /<title>Aiden Agent sign-in failed<\/title>/u);
  assert.match(failure, /Retry sign-in/u);

  const { startOAuthCallbackServer } = await import(pathToFileURL(
    path.join(packageRoot, "dist", "auth", "oauth", "callback-server.js"),
  ).href);
  const server = await startOAuthCallbackServer({
    providerName: "OpenAI", host: "127.0.0.1", port: 0, path: "/auth/callback",
    state: "test-state", complete: async (code) => code,
  });
  try {
    const response = await fetch(`${server.redirectUri}?state=test-state&code=accepted`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Your OpenAI account is connected to Aiden Agent/u);
    assert.equal(await server.wait(), "accepted");
  } finally {
    server.close();
  }

  await writeFile(path.join(root, "resources", "app-icon.png"), "replacement-icon");
  assert.deepEqual(await patchPiOAuthBranding(root), { changed: true });
  const refreshedPage = await readFile(
    path.join(packageRoot, "dist", "utils", "oauth-page.js"),
    "utf8",
  );
  assert.match(refreshedPage, new RegExp(Buffer.from("replacement-icon").toString("base64"), "u"));
});

test("fails closed when the pinned Pi package changes", async (t) => {
  const { packageRoot, root } = await fixture(t);
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  await writeFile(packageJsonPath, `${JSON.stringify({ ...packageJson, version: "0.84.1" })}\n`);
  await assert.rejects(patchPiOAuthBranding(root), /Expected @earendil-works\/pi-ai 1\.0\.3/u);
});

test("fails closed when an upstream callback template drifts", async (t) => {
  const { packageRoot, root } = await fixture(t);
  const oauthPagePath = path.join(packageRoot, "dist", "utils", "oauth-page.js");
  const page = await readFile(oauthPagePath, "utf8");
  await writeFile(
    oauthPagePath,
    page
      .replace("Authentication successful", "Unexpected upstream heading")
      .replace("Aiden Agent sign-in successful", "Unexpected upstream heading"),
  );
  await assert.rejects(patchPiOAuthBranding(root), /success page changed unexpectedly/u);
});
