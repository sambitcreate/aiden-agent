import { createHash } from "node:crypto";
import { app, logger } from "../platform.js";
import { configStore } from "./config-store.js";
import {
  SubagentFileMutationPreparer,
  pinSubagentWorkspaceRoot,
} from "./subagents/subagent-file-mutation-core.js";
import { createSubagentFileMutatorClient } from "./subagents/subagent-file-mutator-io.js";
import {
  createSourceDesignerMultifileCoordinator,
  type SourceDesignerMultifileFilePort,
  type SourceDesignerMultifileObservation,
} from "./source-designer-multifile-coordinator.js";
import { SourceDesignerMultifileJournalStore } from "./source-designer-multifile-journal.js";
import type { SourceDesignerMultifileActionViewV1 } from "../../renderer/shared/source-designer.js";

async function workspaceRoot(workspaceId: string, expectedRootFingerprint?: string) {
  const workspace = await configStore.getWorkspace(workspaceId);
  if (!workspace?.folderPath) throw new Error("The Designer Action workspace is unavailable.");
  const root = await pinSubagentWorkspaceRoot(workspace.folderPath);
  const rootFingerprint = createHash("sha256")
    .update(`${root.canonicalPath}\0${root.device}\0${root.inode}`)
    .digest("hex");
  if (expectedRootFingerprint && expectedRootFingerprint !== rootFingerprint) {
    throw new Error("The Designer Action workspace root identity changed.");
  }
  return { root, rootFingerprint };
}

function observation(
  path: string,
  content: string,
  rootFingerprint: string,
): SourceDesignerMultifileObservation {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.toString("utf8") !== content) {
    throw new Error("Multi-file Designer Actions support UTF-8 source files only.");
  }
  return {
    path,
    noFollow: true,
    contained: true,
    kind: "regular-file",
    bytes,
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    rootFingerprint,
  };
}

const files: SourceDesignerMultifileFilePort = {
  async inspect(input) {
    const { root, rootFingerprint } = await workspaceRoot(
      input.workspaceId,
      input.expectedRootFingerprint,
    );
    const requestId = createHash("sha256")
      .update(`multifile-inspect\0${input.workspaceId}\0${input.path}`)
      .digest("hex");
    const client = createSubagentFileMutatorClient({ workspaceRoot: root });
    try {
      const inspected = await client.inspect(requestId, input.path);
      if (inspected.expectedRevision === "absent" || inspected.currentContent === undefined) {
        throw new Error("Multi-file Designer Actions cannot create an unproven source file.");
      }
      return observation(input.path, inspected.currentContent, rootFingerprint);
    } finally {
      await client.close().catch(() => undefined);
    }
  },

  async write(input) {
    const { root, rootFingerprint } = await workspaceRoot(
      input.workspaceId,
      input.expectedRootFingerprint,
    );
    const content = Buffer.from(input.bytes).toString("utf8");
    if (Buffer.from(content, "utf8").compare(Buffer.from(input.bytes)) !== 0) {
      throw new Error("Multi-file Designer Actions support UTF-8 source files only.");
    }
    const client = createSubagentFileMutatorClient({ workspaceRoot: root });
    try {
      const inspected = await client.inspect(input.effectId, input.path);
      if (
        inspected.expectedRevision === "absent" ||
        inspected.expectedRevision !== input.expectedSha256 ||
        inspected.currentContent === undefined
      ) {
        throw new Error("The multi-file Designer Action source changed before its write.");
      }
      const preparer = new SubagentFileMutationPreparer({
        allocateEffectId: () => input.effectId,
      });
      const effect = preparer.prepareWrite({ inspection: inspected, content });
      await client.prepare(effect);
      await client.commit(input.effectId);
      await client.finalize(input.effectId);
      return observation(input.path, content, rootFingerprint);
    } finally {
      await client.close().catch(() => undefined);
    }
  },
};

export const sourceDesignerMultifileJournal = new SourceDesignerMultifileJournalStore(() =>
  app.getPath("userData"),
);

export const sourceDesignerMultifileCoordinator = createSourceDesignerMultifileCoordinator({
  journal: sourceDesignerMultifileJournal,
  files,
});

function utf8Image(base64: string): string {
  const bytes = Buffer.from(base64, "base64");
  const text = bytes.toString("utf8");
  if (Buffer.from(text, "utf8").compare(bytes) !== 0) {
    throw new Error("Multi-file Designer Action review supports UTF-8 source only.");
  }
  return text;
}

export async function listSourceDesignerMultifileActions(
  projectId: string,
): Promise<SourceDesignerMultifileActionViewV1[]> {
  const records = await sourceDesignerMultifileJournal.listProject(projectId);
  return records.map((record) => ({
    version: 1,
    actionId: record.actionId,
    workspaceId: record.workspaceId,
    projectId,
    label: record.label,
    stage: record.stage,
    files: record.files.map((file) => ({
      path: file.path,
      before: utf8Image(file.before.base64),
      after: utf8Image(file.after.base64),
      beforeSha256: file.before.sha256,
      afterSha256: file.after.sha256,
    })),
    ...(record.recovery
      ? {
          recovery: {
            kind: record.recovery.kind,
            conflicts: record.recovery.conflicts.map(({ path, reason }) => ({ path, reason })),
          },
        }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }));
}

export async function sourceDesignerMultifileAction(
  projectId: string,
  actionId: string,
): Promise<SourceDesignerMultifileActionViewV1> {
  const actions = await listSourceDesignerMultifileActions(projectId);
  const action = actions.find((entry) => entry.actionId === actionId);
  if (!action) throw new Error("That multi-file Designer Action is unavailable.");
  return action;
}

export async function recoverSourceDesignerMultifileActions(projects?: {
  get(projectId: string): Promise<
    | {
        id: string;
        chatId: string;
        revision: number;
        workspaceId?: string;
        connectionState: string;
        canvas: { nodes: Array<{ id: string; kind: string }> };
      }
    | null
    | undefined
  >;
}): Promise<void> {
  const results = [];
  for (const record of await sourceDesignerMultifileJournal.listInterrupted()) {
    if (record.projectId) {
      const project = await projects?.get(record.projectId);
      const authorized =
        project?.connectionState === "connected" &&
        project.chatId === record.chatId &&
        project.workspaceId === record.workspaceId &&
        project.revision === record.projectRevision &&
        Boolean(
          record.sourceNodeId &&
          project.canvas.nodes.some(
            (node) => node.kind === "source-preview" && node.id === record.sourceNodeId,
          ),
        );
      const revoked = await sourceDesignerMultifileCoordinator.revoke(
        record.actionId,
        authorized
          ? "A restarted source-backed Designer Action was rolled back for a fresh ownership review."
          : "The owning Design Project authority changed before restart recovery.",
      );
      results.push({
        status:
          revoked.stage === "recoverable"
            ? ("recoverable" as const)
            : revoked.stage === "undone"
              ? ("undone" as const)
              : ("rolled-back" as const),
        record: revoked,
      });
      continue;
    }
    results.push(await sourceDesignerMultifileCoordinator.resume(record.actionId));
  }
  for (const result of results) {
    if (result.status === "recoverable") {
      logger.error(
        "source-designer-multifile",
        `Designer Action ${result.record.actionId} needs conflict review.`,
      );
    }
  }
}
