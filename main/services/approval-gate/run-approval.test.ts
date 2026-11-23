import assert from "node:assert/strict";
import test from "node:test";

import type { AppSettings, Workspace } from "../types.js";
import {
  approvalCeilingOf,
  currentWorkspaceApproval,
  generationApprovalPolicy,
  legacyAccessOf,
  type ApprovalCeiling,
} from "./run-approval.js";

function workspace(fields: Partial<Workspace>): Workspace {
  return { id: "worktree-1", name: "app", folderPath: "/tmp/app", permission: "ask", createdAt: 0, ...fields } as Workspace;
}

const ASK_LEAD: ApprovalCeiling = { mode: "ask", macGrants: [], chatOnly: false };

test("a started chat in a Never-ask worktree under an Ask lead asks, and loses Full reach", async () => {
  const never = workspace({ approvalMode: "never", macGrants: { shell: true, files: true } } as Partial<Workspace>);
  const alone = await generationApprovalPolicy(
    { workspace: never, botBound: false, mode: undefined, permission: undefined },
    async () => ({ approvalMode: "auto" }),
  );
  assert.equal(alone?.mode, "never");

  const started = await generationApprovalPolicy(
    { workspace: never, botBound: false, mode: undefined, permission: undefined, ceiling: ASK_LEAD },
    async () => ({ approvalMode: "auto" }),
  );
  assert.equal(started?.mode, "ask");
  assert.equal(started?.macGrants.size, 0);
  assert.equal(legacyAccessOf(started!), "ask");
});

test("a mode change in the middle of a started chat's turn still stays under the ceiling", async () => {
  let current = workspace({ approvalMode: "ask" } as Partial<Workspace>);
  const ports = {
    getSettings: async (): Promise<Pick<AppSettings, "approvalMode">> => ({ approvalMode: "ask" }),
    getWorkspace: async () => current,
  };
  assert.equal((await currentWorkspaceApproval(ports, current.id, ASK_LEAD))?.mode, "ask");
  // The person switches the worktree to Never ask while the turn runs.
  current = workspace({ approvalMode: "never", permission: "full" } as Partial<Workspace>);
  assert.equal((await currentWorkspaceApproval(ports, current.id))?.mode, "never");
  const reread = await currentWorkspaceApproval(ports, current.id, ASK_LEAD);
  assert.equal(reread?.mode, "ask");
  assert.equal(reread?.legacyFull, false);
});

test("the ceiling keeps the stricter mode, only the Mac grants both allow, and Chat only from either", async () => {
  const settings = async () => ({ approvalMode: "auto" as const });
  const child = workspace({ approvalMode: "auto", macGrants: { shell: true, "computer-use": true } } as Partial<Workspace>);
  const lead = approvalCeilingOf({
    mode: "never",
    customized: true,
    chatOnly: false,
    macGrants: new Set(["shell", "files"]),
    legacyFull: false,
  });
  const policy = await generationApprovalPolicy(
    { workspace: child, botBound: false, mode: undefined, permission: undefined, ceiling: lead },
    settings,
  );
  // Auto is stricter than the lead's Never ask, so the child keeps Auto.
  assert.equal(policy?.mode, "auto");
  assert.deepEqual([...policy!.macGrants], ["shell"]);
  assert.equal(policy?.chatOnly, false);

  const chatOnlyLead = await generationApprovalPolicy(
    { workspace: child, botBound: false, mode: undefined, permission: undefined, ceiling: { ...lead, chatOnly: true } },
    settings,
  );
  assert.equal(chatOnlyLead?.chatOnly, true);
  assert.equal(legacyAccessOf(chatOnlyLead!), "none");
});
