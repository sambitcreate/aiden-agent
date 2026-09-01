import assert from "node:assert/strict";
import test from "node:test";
import { AidenRemoteMemorySettingsService } from "./aiden-remote-memory-settings.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import type { AppSettings } from "./types.js";

function fixture(initial: AppSettings = {}) {
  let settings = structuredClone(initial);
  return new AidenRemoteMemorySettingsService({
    getSettings: async () => structuredClone(settings),
    setSettings: async (patch) => {
      settings = { ...settings, ...patch };
      return structuredClone(settings);
    },
  });
}

test("global memory defaults on and updates through a revision-checked foreground mutation", async () => {
  const service = fixture();
  const current = await service.get();
  assert.equal(current.enabled, true);
  assert.match(current.revision, /^rev_[A-Za-z0-9_-]{43}$/u);
  const saved = await service.update(current.revision, {
    enabled: false,
    confirmedForeground: true,
  });
  assert.equal(saved.enabled, false);
  assert.notEqual(saved.revision, current.revision);
});

test("global memory rejects stale revisions and non-foreground payloads", async () => {
  const service = fixture({ memoryEnabled: false });
  await assert.rejects(
    service.update("rev_stale", { enabled: true, confirmedForeground: true }),
    (error: unknown) =>
      error instanceof AidenRemoteServiceError && error.code === "revision_conflict",
  );
  const current = await service.get();
  await assert.rejects(
    service.update(current.revision, { enabled: true }),
    (error: unknown) =>
      error instanceof AidenRemoteServiceError && error.code === "permission_confirmation_required",
  );
});

test("concurrent updates serialize the revision check with the write", async () => {
  let settings: AppSettings = {};
  let releaseFirstWrite!: () => void;
  const firstWriteReleased = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  let firstWriteStarted!: () => void;
  const firstWritePending = new Promise<void>((resolve) => {
    firstWriteStarted = resolve;
  });
  let writes = 0;
  const service = new AidenRemoteMemorySettingsService({
    getSettings: async () => structuredClone(settings),
    setSettings: async (patch) => {
      writes += 1;
      if (writes === 1) {
        firstWriteStarted();
        await firstWriteReleased;
      }
      settings = { ...settings, ...patch };
      return structuredClone(settings);
    },
  });
  const current = await service.get();
  const first = service.update(current.revision, {
    enabled: false,
    confirmedForeground: true,
  });
  await firstWritePending;
  const second = service.update(current.revision, {
    enabled: false,
    confirmedForeground: true,
  });
  const secondOutcome = second.then(
    () => "saved" as const,
    (error: unknown) => error,
  );
  releaseFirstWrite();
  assert.equal((await first).enabled, false);
  const conflict = await secondOutcome;
  assert.equal(conflict instanceof AidenRemoteServiceError, true);
  assert.equal(conflict instanceof AidenRemoteServiceError ? conflict.code : undefined, "revision_conflict");
  assert.equal(writes, 1);
});
