// The global mode and a workspace's policy (plan §3.1, §7): no existing
// install lands on Auto, a Full workspace keeps its reach, and what a workspace
// writes stays readable, never wider, by the previous release.

import assert from "node:assert/strict";
import test from "node:test";

import {
  approvalModeAfterUpgrade,
  effectiveApprovalMode,
  parseApprovalSettingsPatch,
  workspaceApprovalPatch,
  workspaceApprovalPolicy,
} from "../../../renderer/shared/approval-mode.js";
import { legacyAccessOf } from "./run-approval.js";
import { workspaceToolApproval } from "./workspace-tool-approval.js";

test("migration: no install already in use is moved to Auto", () => {
  for (const evidence of [
    { stored: false, upgradedProfile: true, inUse: false },
    { stored: false, upgradedProfile: false, inUse: true },
    { stored: false, upgradedProfile: true, inUse: true },
  ]) {
    assert.equal(approvalModeAfterUpgrade(evidence), "ask", JSON.stringify(evidence));
  }
  // A fresh install stays unset, and a stored choice is never rewritten.
  assert.equal(approvalModeAfterUpgrade({ stored: false, upgradedProfile: false, inUse: false }), undefined);
  assert.equal(approvalModeAfterUpgrade({ stored: true, upgradedProfile: true, inUse: true }), undefined);
});

test("a fresh install is Auto once a usable model exists, else Ask; a stored mode is kept", () => {
  assert.equal(effectiveApprovalMode({ approvalModeOrigin: "fresh" }, true), "auto");
  assert.equal(effectiveApprovalMode({ approvalModeOrigin: "fresh" }, false), "ask");
  // Never seeded (an unreadable settings file): could be an install in use, so Ask.
  assert.equal(effectiveApprovalMode({}, true), "ask");
  assert.equal(effectiveApprovalMode({ approvalMode: "auto" }, false), "ask");
  assert.equal(effectiveApprovalMode({ approvalMode: "ask" }, true), "ask");
  assert.equal(effectiveApprovalMode({ approvalMode: "never" }, false), "never");
  // A hand-edited value that isn't a mode is Ask, never Auto.
  assert.equal(effectiveApprovalMode({ approvalMode: "yolo" }, true), "ask");
});

test("a Full workspace becomes customized Never ask with shell and files allowed: the same reach", () => {
  const policy = workspaceApprovalPolicy({ permission: "full" }, "ask");
  assert.deepEqual(
    { mode: policy.mode, customized: policy.customized, grants: [...policy.macGrants].sort() },
    { mode: "never", customized: true, grants: ["files", "shell"] },
  );
  assert.equal(legacyAccessOf(policy), "full");
  // Every call Full access ran without a card still runs.
  for (const call of [
    { toolName: "run_command", args: { command: "npm test" } },
    { toolName: "edit_file", args: { path: "src/a.ts", oldText: "a", newText: "b" } },
    { toolName: "write_file", args: { path: "src/b.ts", content: "x" } },
    { toolName: "browser_click", args: { ref: "e1" } },
  ]) {
    const legacy = workspaceToolApproval({ ...call, permission: "full", workspaceId: "w" }).decision.outcome;
    const migrated = workspaceToolApproval({
      ...call,
      permission: "full",
      workspaceId: "w",
      approval: { mode: policy.mode, macGrants: policy.macGrants },
    }).decision.outcome;
    assert.equal(legacy, "allow", call.toolName);
    assert.equal(migrated, legacy, call.toolName);
  }
});

test("Ask first follows the global mode; No access is Chat only", () => {
  const ask = workspaceApprovalPolicy({ permission: "ask" }, "auto");
  assert.equal(ask.mode, "auto");
  assert.equal(ask.customized, false);
  assert.equal(legacyAccessOf(ask), "ask");
  const none = workspaceApprovalPolicy({ permission: "none" }, "never");
  assert.equal(none.chatOnly, true);
  assert.equal(legacyAccessOf(none), "none");
});

test("changing a migrated Full workspace keeps its grants visible and is never read wider by the previous release", () => {
  const patch = workspaceApprovalPatch({ permission: "full" }, { mode: "ask" });
  assert.deepEqual(patch, { permission: "ask", approvalMode: "ask", macGrants: { shell: true, files: true } });
  // The previous release reads only `permission`: Ask first.
  const stored = { permission: patch.permission!, approvalMode: patch.approvalMode, macGrants: patch.macGrants };
  assert.equal(stored.permission, "ask");
  const after = workspaceApprovalPolicy(stored, "never");
  assert.equal(after.mode, "ask");
  assert.equal(after.customized, true);
  // Back to the global mode, then a grant removed.
  const followGlobal = workspaceApprovalPatch(stored, { mode: null });
  assert.equal(followGlobal.approvalMode, null);
  const revoked = workspaceApprovalPatch({ ...stored, approvalMode: undefined }, { revokeMac: "shell" });
  assert.deepEqual(revoked.macGrants, { files: true });
});

test("settings patches accept only the three modes and never the migration marker", () => {
  assert.deepEqual(parseApprovalSettingsPatch({ approvalMode: "never" }), { approvalMode: "never" });
  assert.throws(() => parseApprovalSettingsPatch({ approvalMode: "full" }));
  assert.deepEqual(parseApprovalSettingsPatch({ approvalModeOrigin: "upgrade" }), {});
  assert.deepEqual(parseApprovalSettingsPatch({ approvalModel: { providerId: "ollama", model: "qwen3" } }), {
    approvalModel: { providerId: "ollama", model: "qwen3" },
  });
  assert.deepEqual(parseApprovalSettingsPatch({ approvalModel: null }), { approvalModel: undefined });
  assert.throws(() => parseApprovalSettingsPatch({ approvalModel: { providerId: 3 } }));
});
