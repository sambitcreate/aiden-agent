import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesignSystemOffers, findWorkspaceDesignSystem } from "./design-system-offers.js";

async function tempDir(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-system-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function write(root: string, relativePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await fs.writeFile(path.join(root, relativePath), text);
}

test("the workspace scan reads its style files but not vendored code, Aiden's design folder or credential files", async (t) => {
  const root = await tempDir(t);
  await write(
    root,
    "src/styles/globals.css",
    ":root { --brand: #2f6fed; --font-sans: 'Inter', sans-serif }",
  );
  await write(root, "node_modules/lib/theme.css", ":root { --vendor: #123456 }");
  await write(root, "design/old.css", ":root { --aiden: #654321 }");
  await write(root, ".env.css", ":root { --secret: #abcdef }");
  await write(root, "src/app.ts", "export const color = '#ffffff';");

  const detected = await findWorkspaceDesignSystem(root);
  assert.deepEqual(
    detected.colors.map((color) => [color.name, color.value]),
    [["--brand", "#2f6fed"]],
  );
  assert.deepEqual(
    detected.fonts.map((font) => font.family),
    ["Inter"],
  );
  assert.deepEqual(detected.sources, ["src/styles/globals.css"]);
});

test("a workspace is offered its design system once, and the log survives a restart", async (t) => {
  const root = await tempDir(t);
  const userData = await tempDir(t);
  await write(root, "app/globals.css", ":root { --primary: #0a7cff } .dark { --primary: #66b2ff }");
  const file = () => path.join(userData, "design-system-offers.json");

  const offers = new DesignSystemOffers({ file, now: () => 1_000 });
  const first = await offers.offerFor(root);
  assert.match(first, /--primary #0a7cff \(dark #66b2ff\)/u);
  assert.equal(await offers.offerFor(root), "", "not twice in one run");
  await offers.settle(root, true);

  const afterRestart = new DesignSystemOffers({ file });
  assert.equal(await afterRestart.offerFor(root), "", "not again after a restart");
  const log = await fs.readFile(file(), "utf8");
  // The log holds neither the folder's path nor its plain hash, which anyone could compute from a guessed path.
  assert.doesNotMatch(log, new RegExp(path.basename(root), "u"));
  assert.ok(!log.includes(createHash("sha256").update(path.resolve(root)).digest("hex")));
  const key = await fs.stat(`${file()}.key`);
  if (process.platform !== "win32") assert.equal(key.mode & 0o777, 0o600);

  // A new install key makes every logged workspace unknown, so it is offered again.
  await fs.rm(`${file()}.key`);
  assert.match(await new DesignSystemOffers({ file }).offerFor(root), /--primary #0a7cff/u);
});

test("an offer is logged only once its turn ended normally, and a failed turn's offer is made again", async (t) => {
  const root = await tempDir(t);
  const userData = await tempDir(t);
  await write(root, "theme.css", ":root { --brand: #2f6fed }");
  const file = () => path.join(userData, "design-system-offers.json");

  const offers = new DesignSystemOffers({ file });
  assert.match(await offers.offerFor(root), /--brand #2f6fed/u);
  // An app quit mid-turn never settles it, so a restart offers again.
  assert.match(await new DesignSystemOffers({ file }).offerFor(root), /--brand #2f6fed/u);

  await offers.settle(root, false);
  assert.match(
    await offers.offerFor(root),
    /--brand #2f6fed/u,
    "a failed or stopped turn leaves it for the next",
  );
  await offers.settle(root, true);
  assert.equal(await offers.offerFor(root), "");
  assert.equal(await new DesignSystemOffers({ file }).offerFor(root), "");
});

test("no offer when the workspace already has design/tokens.css or sets up nothing", async (t) => {
  const userData = await tempDir(t);
  const file = () => path.join(userData, "design-system-offers.json");

  const withTokens = await tempDir(t);
  await write(withTokens, "design/tokens.css", ":root { --brand: #111 }");
  await write(withTokens, "src/index.css", ":root { --brand: #2f6fed }");
  assert.equal(await new DesignSystemOffers({ file }).offerFor(withTokens), "");

  const plain = await tempDir(t);
  await write(plain, "index.html", "<p>hello</p>");
  const offers = new DesignSystemOffers({ file });
  assert.equal(await offers.offerFor(plain), "");
  // Nothing found is not logged, so a theme added later can still be offered after a restart.
  await write(plain, "styles.css", ":root { --brand: #2f6fed }");
  assert.match(await new DesignSystemOffers({ file }).offerFor(plain), /--brand #2f6fed/u);
});

test("an unreadable log counts as empty and a failed write still sends the offer", async (t) => {
  const root = await tempDir(t);
  const userData = await tempDir(t);
  await write(root, "theme.css", ":root { --brand: #2f6fed }");
  await fs.writeFile(path.join(userData, "log.json"), "{ not json");
  // The log's directory is a file, so writing it fails.
  await fs.writeFile(path.join(userData, "blocked"), "");
  const errors: unknown[] = [];
  const offers = new DesignSystemOffers({
    file: () => path.join(userData, "blocked", "log.json"),
    onSaveError: (error) => errors.push(error),
  });
  assert.match(await offers.offerFor(root), /--brand #2f6fed/u);
  await offers.settle(root, true);
  assert.equal(errors.length, 1);

  const corrupt = new DesignSystemOffers({ file: () => path.join(userData, "log.json") });
  assert.match(await corrupt.offerFor(root), /--brand #2f6fed/u);
});
