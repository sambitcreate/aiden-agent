import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import playwrightTest from "@playwright/test";
import type * as PlaywrightTestModule from "@playwright/test";

const { expect, test } =
  playwrightTest as unknown as typeof PlaywrightTestModule;

// A standalone native guest, as in bot-browser.spec.ts: the real browser
// service, sign_in tool, hand-off cards and card opener, without starting
// unrelated application services.
test("a Bot's sign-in opens in a held tab of its own browser that it can't read until the person is signed in", async () => {
  const testInfo = test.info();
  const root = testInfo.outputPath("native");
  await mkdir(path.resolve("build"), { recursive: true });
  const temporaryBuild = await mkdtemp(path.resolve("build/native-bot-sign-in-"));
  let output = "";
  const entry = path.join(temporaryBuild, "bot-sign-in.mjs");
  try {
    await build({
      entryPoints: [path.resolve("tests/e2e/bot-sign-in-native.ts")],
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      external: ["electron"],
      tsconfigRaw: { compilerOptions: {} },
      logLevel: "silent",
    });
    const electron = createRequire(import.meta.url)("electron") as string;
    // No GPU on hosted runners; SIGKILL on timeout so a hang shows its stderr.
    // Chromium refuses to start as root (a container) unless its sandbox is off.
    const sandbox = process.getuid?.() === 0 ? ["--no-sandbox"] : [];
    const run = await promisify(execFile)(electron, ["--disable-gpu", ...sandbox, entry], {
      timeout: 75_000,
      killSignal: "SIGKILL",
      env: {
        PATH: process.env.PATH,
        AIDEN_BOT_SIGN_IN_ROOT: root,
        AIDEN_CONFIG_DIR: path.join(root, "config"),
        ...(process.platform === "linux"
          ? Object.fromEntries(
              ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE"]
                .filter((name) => process.env[name] !== undefined)
                .map((name) => [name, process.env[name]]),
            )
          : {}),
      },
    });
    output = `${run.stdout}${run.stderr}`;
  } finally {
    await rm(temporaryBuild, { recursive: true, force: true });
  }
  const raw = await readFile(path.join(root, "result.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    throw new Error(`The Bot sign-in fixture exited without a result:\n${output}`);
  });
  const result = JSON.parse(raw);

  // The card names the site's origin, not the page the Bot asked for.
  expect(result.card).toEqual({
    kind: "sign_in",
    action: "Sign in to accounts.example.com",
    why: "To read your project settings.",
    origin: "https://accounts.example.com",
    open: { url: "https://accounts.example.com" },
    target: "browser",
  });

  // Open sign-in opens the origin in the Bot's own browser, nowhere else.
  expect(result.opened).toBe("browser");
  expect(result.elsewhere).toEqual([]);
  expect(result.held.reason).toBe("sign_in");
  expect(result.held.profileId).toBe("bot:bot:ada");
  expect(result.held.url).toBe("https://accounts.example.com/");

  // While the person holds it, the Bot gets neither the page nor its address.
  expect(result.held.snapshot).toBe(result.expected.heldRefusal);
  expect(result.held.navigate).toBe(result.expected.heldRefusal);
  for (const status of [result.held.status, result.held.statusAfterCallback]) {
    expect(status.url).toBe("");
    expect(status.title).toBe(result.expected.heldTitle);
  }
  expect(result.held.gatewayMentionsSite).toBe(false);

  // I'm signed in: the Bot hears the plan's words, gets its tab back and is signed in there.
  expect(result.answer).toBe(result.expected.answer);
  expect(result.released).toBe(true);
  expect(result.botSees).toBe(true);
  expect(result.botSeesPassword).toBe(false);
  expect(result.botCookies).toEqual(["sid=person-session"]);

  // The person's own browser is not signed in by the Bot's sign-in.
  expect(result.personSees).toBe("cookie: none");
  expect(result.personCookies).toEqual([]);
});
