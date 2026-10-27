import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as nodePath from "node:path";
import test from "node:test";
import { build } from "esbuild";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture() {
  const installer = "/cache/Aiden-Agent-1.2.3-x86_64-linux.AppImage";
  const sha256 = "ab".repeat(32);
  const download = deferred<string[]>();
  const verification = deferred<{ installer: string; sha256: string }>();
  const verified = deferred<AbortSignal>();
  const replacements: { verifiedSha256: string }[] = [];
  let eligible = true;
  let instance!: FakeAppImageUpdater;
  class FakeAppImageUpdater extends EventEmitter {
    installerPath = installer;
    downloadedUpdateHelper = { downloadedFileInfo: { sha512: "feed-checksum" } };
    installAttempts = 0;
    constructor() { super(); instance = this; }
    async checkForUpdates() { return { isUpdateAvailable: true, updateInfo: { version: "1.2.3" } }; }
    downloadUpdate() { return download.promise; }
    install() {
      if (this.installAttempts > 0) return false;
      this.installAttempts += 1;
      return this.doInstall({ isForceRunAfter: true });
    }
    quitAndInstall() { this.install(); }
    protected doInstall(_options: { isForceRunAfter: boolean }): boolean { throw new Error("unguarded SDK installer must not run"); }
    async spawnLog() {}
  }
  class CancellationToken { cancelled = false; cancel() { this.cancelled = true; } }
  const mocks: Record<string, unknown> = {
    "electron-updater": { AppImageUpdater: FakeAppImageUpdater, CancellationToken },
    "../platform.js": {
      app: { getVersion: () => "1.2.2" }, dialog: { showMessageBox: async () => ({ response: 0 }) },
      logger: { debug() {}, error() {}, info() {}, warn() {} },
    },
    "../runtime-mode.js": { isPackagedRuntime: () => true },
    "../runtime-profile.js": { currentRuntimeProfile: () => ({ id: "production" }) },
    "node:fs": { existsSync: () => true },
    "node:path": nodePath,
    "./app-updater-linux.js": {
      appImageIdentity: () => ({ path: "/Applications/Aiden.AppImage", dev: 1, ino: 2 }),
      canUpdateLinuxAppImage: () => eligible,
      replaceAppImageAtomically: (options: { eligible: () => boolean; verifiedSha256: string }) => {
        assert.equal(options.eligible(), true);
        replacements.push(options);
        return "/Applications/Aiden.AppImage";
      },
    },
    "./app-updater-linux-provenance.js": {
      verifyAppImageProvenance: ({ signal }: { signal: AbortSignal }) => {
        verified.resolve(signal);
        return verification.promise;
      },
    },
  };
  mocks["node:module"] = { createRequire: () => (name: string) => {
    assert.ok(name in mocks, `unexpected lazy dependency ${name}`);
    return mocks[name];
  } };
  const bundle = await build({
    entryPoints: [new URL("./app-updater.ts", import.meta.url).pathname], bundle: true,
    write: false, platform: "node", format: "cjs", external: Object.keys(mocks),
    // createRequire is replaced by the injected SDK, so import.meta is unused.
    logOverride: { "empty-import-meta": "silent" },
  });
  const module = { exports: {} as typeof import("./app-updater.js") };
  new Function("require", "module", "exports", "process", bundle.outputFiles[0]!.text)(
    (name: string) => { assert.ok(name in mocks, `unexpected dependency ${name}`); return mocks[name]; },
    module, module.exports,
    { platform: "linux", arch: "x64", resourcesPath: "/mount/resources", execPath: "/mount/aiden-agent", env: { APPIMAGE: "/Applications/Aiden.AppImage", APPDIR: "/mount" } },
  );
  const service = new module.exports.AppUpdateService();
  service.start();
  return { service, download, verification, verified, replacements,
    sdk: () => instance, setEligible: (value: boolean) => { eligible = value; },
    proof: { installer, sha256 } };
}

test("Linux readiness and both quit install paths require publisher verification, including protected shutdown", async () => {
  const f = await fixture();
  try {
    const checking = f.service.checkNow(false);
    f.download.resolve([f.proof.installer]);
    await f.verified.promise;
    assert.equal(f.service.snapshot().status, "downloading");
    assert.equal(f.service.installDownloadedUpdateAndRestart(), false);
    assert.equal(f.sdk().install(), false, "SDK auto-install on normal quit must also be gated");
    assert.equal(f.sdk().installAttempts, 0, "verification must precede the SDK's one-shot install flag");
    assert.equal(f.replacements.length, 0);
    f.verification.resolve(f.proof);
    assert.deepEqual(await checking, { outcome: "ready" });
    f.service.dispose();
    assert.equal(f.service.installDownloadedUpdateAndRestart(), true);
    assert.equal(f.replacements.length, 1);
    assert.equal(f.replacements[0]!.verifiedSha256, f.proof.sha256);
  } finally { f.service.dispose(); }
});

test("failed provenance never makes the Linux download ready or enables normal-quit replacement", async () => {
  const f = await fixture();
  try {
    const checking = f.service.checkNow(false);
    f.download.resolve([f.proof.installer]);
    await f.verified.promise;
    f.verification.reject(new Error("wrong publisher workflow"));
    assert.deepEqual(await checking, { outcome: "failed" });
    assert.equal(f.service.snapshot().status, "error");
    assert.equal(f.sdk().install(), false);
    assert.equal(f.replacements.length, 0);
  } finally { f.service.dispose(); }
});

for (const boundary of ["dispose", "eligibility", "installer"] as const) {
  test(`verification finishing after ${boundary} cannot authorize Linux replacement`, async () => {
    const f = await fixture();
    try {
      const checking = f.service.checkNow(false);
      f.download.resolve([f.proof.installer]);
      const signal = await f.verified.promise;
      if (boundary === "dispose") { f.service.dispose(); assert.equal(signal.aborted, true); }
      if (boundary === "eligibility") f.setEligible(false);
      if (boundary === "installer") f.sdk().installerPath = "/cache/replaced.AppImage";
      f.verification.resolve(f.proof);
      assert.deepEqual(await checking, { outcome: boundary === "dispose" ? "unavailable" : "failed" });
      assert.equal(f.sdk().install(), false);
      assert.equal(f.replacements.length, 0);
    } finally { f.service.dispose(); }
  });
}
