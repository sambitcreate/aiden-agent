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

const RED = [255, 0, 0];

/** Close to the boundary's gray, never the field's red. */
function painted(rgb: number[]): boolean {
  return rgb.every((channel) => Math.abs(channel - 0x8a) <= 6);
}

// A standalone native guest: the real browser service and Electron sessions,
// without starting unrelated application services.
test("a Bot's browser keeps its own sign-ins, masks secret fields, honours holds and is cleared on delete", async () => {
  const testInfo = test.info();
  const root = testInfo.outputPath("native");
  await mkdir(path.resolve("build"), { recursive: true });
  const temporaryBuild = await mkdtemp(path.resolve("build/native-bot-browser-"));
  let output = "";
  const entry = path.join(temporaryBuild, "bot-browser.mjs");
  try {
    await build({
      entryPoints: [path.resolve("tests/e2e/bot-browser-native.ts")],
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
    // As in browser-throttling.spec.ts: no GPU on hosted runners, and SIGKILL
    // on timeout so a hang shows its stderr instead of a clean exit.
    // Chromium refuses to start as root (a container) unless its sandbox is off.
    const sandbox = process.getuid?.() === 0 ? ["--no-sandbox"] : [];
    const run = await promisify(execFile)(electron, ["--disable-gpu", ...sandbox, entry], {
      timeout: 75_000,
      killSignal: "SIGKILL",
      env: {
        PATH: process.env.PATH,
        AIDEN_BOT_BROWSER_ROOT: root,
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
    throw new Error(`The Bot browser fixture exited without a result:\n${output}`);
  });
  const result = JSON.parse(raw);

  // Separate sign-ins: neither browser sends the other's session cookie.
  expect(result.isolation.botProfile).toBe("bot:bot:ada");
  expect(result.isolation.personSees).toBe("cookie: none");
  expect(result.isolation.botSees).toBe("cookie: sid=bot");
  expect(result.isolation.botCookies).toEqual(["sid=bot"]);
  expect(result.isolation.personCookies).toEqual(["sid=person"]);

  // Secret fields are painted over in the image and left out of the text; an ordinary block stays red.
  expect(result.masking.note).toBe(result.expected.maskedNote);
  for (const field of ["password", "otp", "card"]) expect(painted(result.masking[field]), field).toBe(true);
  expect(result.masking.control).toEqual(RED);
  expect(result.masking.leaked).toEqual([]);
  expect(result.typing).toBe(result.expected.typingRefusal);
  expect(result.noteTyping).toBe("ran");
  expect(result.pressing).toBe(result.expected.typingRefusal);
  expect(result.navigationKey).toBe("ran");
  expect(result.refused).toEqual({
    evaluate: result.expected.actionRefusal,
    record: result.expected.actionRefusal,
    openFile: result.expected.actionRefusal,
    valueSelector: result.expected.valueSelectorRefusal,
    unbounded: "This browser belongs to a Bot.",
  });

  // A cross-site frame can't be checked for fields: no image, and a note saying why.
  expect(result.frame).toEqual({ image: false, note: result.expected.frameNote, leaked: false });

  // A held tab refuses the Bot, not the person, until it is released; then the
  // Bot sees it again with the same fields covered.
  expect(result.hold.heldState).toEqual({ reason: "sign_in" });
  expect(result.hold.held).toBe(result.expected.heldRefusal);
  expect(result.hold.personMayUse).toBe(true);
  const afterRelease = result.hold.afterRelease;
  expect(typeof afterRelease, String(afterRelease)).toBe("object");
  for (const field of ["password", "otp", "card"]) expect(painted(afterRelease[field]), `${field} after release`).toBe(true);
  expect(afterRelease.control).toEqual(RED);
  expect(afterRelease.leaked).toEqual([]);

  // Delete clears the Bot's sign-ins and tabs and leaves the person's alone.
  expect(result.cleared).toEqual({ botCookies: [], personCookies: ["sid=person"], botTabs: 0, personTabs: 1 });
});
