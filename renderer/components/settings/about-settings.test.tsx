import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { softwareUpdateDescription, updateRestartError } from "./about-settings";

const source = readFileSync(new URL("./about-settings.tsx", import.meta.url), "utf8");

test("the About onboarding action stays text-only until it is opening", () => {
  assert.doesNotMatch(source, /Sparkles/u);
  assert.match(source, /showingOnboarding \? <Loader2 className="animate-spin" \/> : null/u);
  assert.match(source, /showingOnboarding \? "Opening…" : "Show onboarding"/u);
});

const ready = { status: "ready", version: "0.67.0" } as const;
const idle = { status: "idle", version: null } as const;

test("Software update text follows the install: Mac, updatable Linux, password-prompt Linux, or manual", () => {
  const mac = { platform: "darwin", appUpdates: true, appUpdateNeedsPassword: false } as const;
  const appImage = { platform: "linux", appUpdates: true, appUpdateNeedsPassword: false } as const;
  const linuxPackage = {
    platform: "linux",
    appUpdates: true,
    appUpdateNeedsPassword: true,
  } as const;
  const manualLinux = {
    platform: "linux",
    appUpdates: false,
    appUpdateNeedsPassword: false,
  } as const;

  assert.match(softwareUpdateDescription(idle, mac), /signed updates/u);
  // Linux updates are checked against the feed digest, never described as signed.
  for (const linux of [appImage, linuxPackage]) {
    assert.doesNotMatch(softwareUpdateDescription(idle, linux), /signed|AppImage/u);
    assert.doesNotMatch(
      softwareUpdateDescription({ status: "checking", version: null }, linux),
      /signed/u,
    );
    assert.doesNotMatch(
      softwareUpdateDescription({ status: "error", version: null, error: "check-failed" }, linux),
      /signed/u,
    );
  }
  assert.equal(
    softwareUpdateDescription(ready, appImage),
    "Aiden Agent 0.67.0 is ready. Restart to finish installing it.",
  );
  assert.equal(
    softwareUpdateDescription(ready, linuxPackage),
    "Aiden Agent 0.67.0 is ready. Update and restart asks for your password to install it.",
  );
  assert.match(softwareUpdateDescription(ready, manualLinux), /package manager/u);
  assert.match(
    softwareUpdateDescription(idle, {
      platform: "other",
      appUpdates: false,
      appUpdateNeedsPassword: false,
    }),
    /GitHub Releases/u,
  );
});

test("a closed password prompt and a failed package install get their own messages", () => {
  assert.equal(updateRestartError({ accepted: true }), null);
  const cancelled = updateRestartError({ accepted: false, reason: "install-cancelled" });
  const failed = updateRestartError({ accepted: false, reason: "install-failed" });
  assert.match(cancelled ?? "", /password prompt was closed/u);
  assert.match(failed ?? "", /couldn’t install/u);
  assert.notEqual(cancelled, failed);
});
