import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type {
  DurableJobCheckpoint,
  DurableJobInput,
} from "../../../renderer/shared/durable-jobs.js";
import { DurableJobStore } from "./store.js";
import type { RecoveryEvidence } from "./contract.js";

export const input: DurableJobInput = {
  profileId: "profile",
  botId: "bot",
  workspaceId: "workspace",
  chatId: "chat",
  messageId: "message",
  turnId: "turn",
  inputRef: "staged-input",
  inputDigest: createHash("sha256").update("request").digest("hex"),
  providerId: "provider",
  modelId: "model",
  authorityRevision: "policy-1",
};
export const checkpoint: DurableJobCheckpoint = {
  sessionId: "session",
  headId: "head",
  inputMessageId: input.messageId,
  operationIds: [],
  childRunIds: [],
};
export const evidence = (
  kind: RecoveryEvidence["kind"],
  overrides: Partial<RecoveryEvidence> = {},
): RecoveryEvidence => ({
  kind,
  checkpoint:
    kind === "checkpoint" || kind === "failed_safe" ? checkpoint : null,
  resultRef: kind === "completed" ? "assistant-result" : null,
  waitId: kind.startsWith("waiting_") ? "approval-1" : null,
  ...overrides,
});

export function fixture(t: TestContext, maxConcurrent = 3) {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-jobs-"));
  let now = 1_000;
  let fail = false;
  const stores: DurableJobStore[] = [];
  const open = () => {
    const store = new DurableJobStore({
      root,
      profileId: input.profileId,
      now: () => now,
      maxConcurrent,
      beforeCommit: () => {
        if (fail) throw new Error("simulated disk failure");
      },
    });
    stores.push(store);
    return store;
  };
  const store = open();
  t.after(() => {
    stores.forEach((s) => s.close());
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    open,
    clock: (value: number) => {
      now = value;
    },
    failWrites: (value: boolean) => {
      fail = value;
    },
  };
}
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
